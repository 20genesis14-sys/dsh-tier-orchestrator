# dsh-tier-router — Architecture

This document explains how the plugin works end to end: what gets installed,
how a user message turns into a routed model call, what state lives where, and
how to extend the system safely. It is written for humans first; LLM agents
should read `AGENTS.md` for the compact working contract.

Target host: **DeepSeek Harness `0.2.1-rc.2`** (Cordis plugin runtime, developer
preview — APIs change between releases, which is why the code is organized the
way it is).

## 1. The one-paragraph model

DSH runs plugins inside Cordis scopes. A *profile bundle* (`cordis.patch.yml`)
can contribute host-plane entries and agent presets. Our bundle contributes
two rows:

- a **host row** `tier-routing` whose `Config` schema carries every user
  setting as *volatile fields* — that is what makes the WebUI settings page
  exist and what makes edits persist into the profile;
- a **`tiered` agent preset** — a copy of the standard 0.2.1 roster plus one
  extra row `tier-routing-agent` (the same npm package, but instantiated with
  `config.plane: 'agent'`).

The same `apply(ctx, config)` runs twice in different scopes. On the host it
does almost nothing (the schema itself does the work). Inside an agent session
on the `tiered` preset it mounts tools, slash commands, listeners, and a system
prompt section — that is where all routing happens.

```
profile patch (cordis.patch.yml)
├── tier-routing        (host)   — volatile config → Settings page, persistence
└── preset-tiered       (preset) — standard roster + tier-routing-agent (agent)
        └─ apply(ctx, {plane:'agent'}) ← everything below runs here
```

## 2. Layering: `core/` vs `dsh/` vs `index.js`

```
lib/
  core/     pure decision logic — no DSH imports, no I/O, fully unit-tested
  dsh/      the only files that know DSH APIs exist — adapters + probes
  index.js  composition root — wires probe results to core decisions
```

The dependency arrow only ever points **inward**: `index.js` imports from both
layers, `dsh/` adapters take plain values and callbacks, `core/` knows nothing
about ctx, services, or async harness APIs.

Why: DSH is a developer preview and has already broken three integration points
between releases. When the next breaking change lands, the fix should be inside
one `lib/dsh/` file, with `core/` and the pure tests untouched.

| File | Responsibility |
| --- | --- |
| `core/tiers.js` | Ordered tier registry (`TIER_ORDER = ['strong','main','cheap']`; `activeTierOrder` picks the two- or three-tier layout), normalization to labels/chains |
| `core/routing.js` | `resolveTierSpec` (the tier decision), fallback chains, effort ladder/validation, `migrateTierConfig` |
| `core/guard.js` | `isHighImpact` / `hasRecursiveForceRm` — deterministic dangerous-action detection |
| `core/policy.js` | Action vocabulary (`route/deny/escalate/raise-effort/fallback`, reserved `ask`) + the escalation state machine |
| `core/consult.js` | Consultation registry (`advisor`, `review`): system prompt, user-prompt builder, output parser; `modelFamily` / `reviewerConflicts` for the reviewer-independence warning |
| `core/metrics.js` | `createDiag` counters for `/tier status` diagnostics |
| `dsh/services.js` | `probeServices` — collects services, probes every method we need → `seams` map; `seamReport` |
| `dsh/routing-seam.js` | Two routing strategies: `mountRequestWaterfall` (0.2+) and `applyHeaderRoute` (legacy) |
| `dsh/subagents.js` | `startWorker` — `startActivation` (0.2+) or legacy `start()` |
| `dsh/jobs.js` | `startBackgroundJob` — `owner` is a `SessionId` |
| `dsh/config.js` | `createConfigBridge` — `settings.describe()`/`update()` on ns `tier-routing`; `vol()` unwraps Volatile refs |

## 3. Data flow: user message → routed model call

```
user message
  └─ agent/inbox/inserted ──► captureBaseline(agent)         (learn session default)
        │
every model request:
  └─ agent/request (payload, next)                            [waterfall seam]
        ├─ seed = await next()                                (config the loop built)
        ├─ resolveRoute(agent, seed):
        │     mode off / delegated main → return baseline     (untouched session model)
        │     else tierNameFor(agent)  → resolveTierSpec:
        │        explicitTier (tier_worker) > off > delegated-main >
        │        escalated > sessionMode > subagentPolicy > auto(plan?strong:cheap)
        │     effectiveTarget(agent, tier):
        │        active fallback chain entry? → chain target (chainFor: explicit pair first when followed)
        │        strong/main + followSession → agentDefaultModel.currentSelection()
        │        cheap                      → cheap config + raised effort (if any)
        │     tierNameFor → planActive ? (three tiers: main, two: strong) : cheap
        └─ return {...seed, provider, model, reasoningEffort} (loop logs the header)
```

Two edge cases have dedicated listeners instead of the waterfall:

- **`session/event` (`plan/mode`)**: folds each flip into the `planStates`
  WeakMap (the real `Session` class exposes no public `.events` array) so the
  next waterfall pass sees the new plan state.
- **`agent/request-error`**: `classifyFallback(failure)` decides —
  `fallback` (model unavailable codes / status≥500) advances the tier's chain
  and returns `{kind:'retry'}`; the retried request picks up the chain target
  through `activeFallbackTarget`. `ignore` codes pass through; anything else
  is left for the escalation path.
- **`agent/error`**: `decideErrorActions` counts errors in a 60s window;
  at 2 errors the session escalates to the strong tier for 180s; otherwise a
  counted cheap-tier failure raises the cheap effort one step.

`agent/request` is preferred because it applies to the **current** request and
the loop writes the `request/header` log itself. When `ctx.on` or the event is
unavailable, `seamMode` falls back to `'header'` — the legacy strategy that
mutates `agent.options` and appends a `request/header` (one-step delay).

## 4. State: what's stored and where

All per-agent state is `WeakMap`-keyed on the agent object (never session-id
strings — agents are GC'd with their sessions):

| Map | Shape | Written by | Read by |
| --- | --- | --- | --- |
| `sessionModes` | `'auto'|'strong'|'cheap'|'delegated'|'off'` | `applyRoute` (`tier_route`, `/tier`) | `effectiveMode`, `tierNameFor` |
| `sessionBaselines` | `{provider,model,reasoningEffort}` | `captureBaseline` (first request/inbox/route call) | `off`/`delegated` restore, `resolveRoute` |
| `childTiers` | tier name | `tier_worker` after spawn (`agents.get(childId)`) | `tierNameFor` (explicitTier) |
| `escalations` | `{count, windowStart, until}` | `agent/error` handler | `isEscalated` |
| `fallbackStates` | `{index, until, tierName}` | `agent/request-error` handler | `activeFallbackTarget` |
| `cheapEfforts` | `{effort, until}` | `raiseCheapEffort` | `currentCheapEffort` |
| `planStates` (keyed on **session**) | `boolean` | `session/event` listener (`plan/mode`), `setPlanMode` | `planActive` — the real `Session` has no public `.events`, so we fold the stream ourselves; `session.events` is only a compat fallback |

Global mutable state lives in one `state` object: `mode` (global default),
`subagentPolicy`, thresholds/TTLs, and `state.tiers` (the registry snapshot).
`diag` is the counters object printed by `/tier status`.

### Escalation state machine

```
idle ──error──► counting(count=1) ──error in window──► escalated(until=now+TTL)
   ▲              │ window expires                      │ TTL expires
   └──────────────┴─────────────────────────────────────┘
```

`escalationStep` returns `{rec, escalated}`; counting records (`until===0`)
survive between errors, expired ones are GC'd on read. `policy.js` documents
the reserved `awaiting-confirm` phase for a future ask-policy.

## 5. Configuration & persistence

The `Config` schema (top of `index.js`) declares flat volatile fields:
`plane`, `mode`, `strong{Provider,Model,Effort,FollowSession,Fallback}`,
`main{...}`, `cheap{...}`, `threeTiers` (layout switch), `rolesEnabled` (roles
switch), `advisor{Provider,Model,Effort}` and `reviewer{Provider,Model,Effort}`
(roles have no follow/fallback fields: they share the strong chain),
`subagentPolicy`. Volatile fields become `Volatile` refs (read
via `.get()` — `dsh/config.js` `vol()` handles both shapes).

- **Host row**: schemastery validates the profile-patch values; the
  SettingsForms machinery renders the settings page and persists user edits.
- **Agent row**: `createConfigBridge` reads `settings.describe()` → entry with
  `ns:'tier-routing'` → `applyPersisted(value)` maps fields onto `state`.
  Writes (`tier_configure`, `/tier set`) go through `settings.update(ns,patch)`
  unless `sessionOnly`. `settings/document-updated` events invalidate the
  bridge cache (2s TTL) and re-apply.
- **No settings service** → bridge reports `readable=false`; everything still
  works in memory and `/tier status` says `config persisted: in-memory only`.

Defaults: strong = `deepseek-official/deepseek-v4-pro@max` with
`followSession: true` and a self-fallback entry; main =
`deepseek-official/deepseek-v4-pro@high` following the session (inactive until
`threeTiers`); cheap = `deepseek-official/deepseek-v4-flash@low` with an empty
chain; roles off with no models; `subagentPolicy: 'inherit'`; `mode: 'auto'`.

**Chains.** `chainFor(tier)` is the one fallback list every path uses (request
waterfall, request-error retries, `/tier status`, consultations). When the tier
follows the session model, its explicit pair is the first entry, deduplicated
against the configured chain. Consultations walk `consultAttempts(role)`: the
role route when roles are on, then the strong route and its chain.

## 6. Tools and commands

| Surface | What it does |
| --- | --- |
| `tier_route` tool / `/tier strong|cheap|auto|delegated|off` | Per-session mode; `persist:true` also writes `agentDefaultModel` |
| `tier_configure` / `/tier set` | Re-point a tier (provider/model/effort/followSession/fallback chain) with `resolveModelInfo` effort validation; persists via settings |
| `tier_advisor` / `/advisor`, `tier_review` / `/tier review` | Strong-tier consultations via `consult.js` specs; `runConsult` walks `attemptChain(primary, strong chain)` through `streamText`, stateless per call |
| `tier_worker` | `startWorker` on a chosen tier; `outputSchema`, `agentPreset` (spawn), `maxDepth`, `background` (jobs) |
| `tier_escalate_effort` / `/tier effort` | One effort step up the ladder, bounded by declared efforts |
| `tier_status` / `/tier status` | Full diagnostics incl. `seams:` capability report |
| `tools/pre-execute` guard | Denies `isHighImpact` calls while the cheap tier executes |

Every registration goes through `safeRegister` — one failed tool/command/
listener never takes the plugin down.

## 7. Capability probe and graceful degradation

At `applyAgentPlane` start, `probeServices(ctx)` produces `seams` — a boolean
map of every method we touch (`llmStream`, `tools`, `subagentsActivation`,
`subagentsLegacy`, `settingsRead`, `settingsWrite`, `jobsStart`, …). Features
consult flags instead of assuming APIs:

- No `llm.stream`/`listProviders` → plugin refuses to mount (logs why).
- No `settings` → in-memory config + honest status.
- No `startActivation` but legacy `start` → adapter picks the old path.
- No `jobs` → `background` worker reports the feature missing.
- `OPTIONAL_SEAMS` (`subagentsLegacy`, `subagentsActivation`,
  `presetRegister`) don't count as "missing" in the status line; subagents as
  a whole are flagged only when *neither* API exists.

`/tier status` prints `routing seam: waterfall|header` and `seams: all ok` or
the missing list — the first thing to check when debugging on a new DSH build.

## 8. The preset row (`cordis.patch.yml`)

Two `- insert:` rows:

1. `id: tier-routing / name: dsh-tier-router` — host config row (volatile
   defaults shown).
2. `id: preset-tiered / name: '@deepseek-ai/dsh-agent-preset'` with
   `config.id: tiered`, `order: 20`, and `plugins:` = the full 0.2.1 standard
   roster (persona, agent-instructions, time-context, tool-bash/pwsh by
   platform, tool-fs, tool-fs-search, tool-jobs, tool-schedule, skill-filesystem,
   tool-skill, command-goal, tool-goal, planning group [plan-mode], compaction
   group, delegation group [subagent-control, subagent spawn/fork,
   workflow-ptc, tool-workflow], tool-ask-user, tool-todo, tool-web, present,
   disabled plugin-manager/market tools) **plus** `tier-routing-agent` with
   `config.plane: agent`.

If a future DSH changes the standard roster, update this list to match the new
`standard.patch.yml`.

## 9. Extension recipes

- **Add a tier**: extend `TIER_ORDER`, add `Config` volatile fields, map them
  in `applyPersisted`/`persistTierConfig`, update `parseSetArgs` and the status
  text. `resolveTierSpec` already works on `first`/`last`, so semantics need
  thought (which tier escalations target, which is the "weak" one for the
  guard).
- **Add a consultation**: one entry in `core/consult.js` `CONSULTS` (system
  prompt, `buildUser`, `parse`), one `defineTool` in `index.js` calling
  `streamText`/`consultSpec`.
- **Ask-before-escalate**: `policy.js` reserves the `ask` action and
  `awaiting-confirm` phase; implement via `tools/pre-execute`'s
  `{kind:'ask'}` or an `ask_user` tool call, then resume/cancel the pending
  route change.
- **Decision models (Jev/Clef/…)**: planned `lib/dsh/decisions.js` — POST
  `{state, questions}` to OpenRouter `/api/alpha/decisions` or any
  `/v1/systemone`-compatible endpoint (model id as a config field). Feed its
  answer into `policy.js`; keep the deterministic policy as the no-key
  fallback. Not for the per-request hot path.
- **Custom settings UI**: the `settings.section` UI slot still exists in 0.2;
  a hand-built card (provider→model→effort cascading selects) can replace the
  generated page later without changing the volatile schema.

## 10. Testing and verification

```sh
npm test           # pure core tests + mocked-context smoke + packaging checks
npm run check      # syntax check every lib file
npm pack --dry-run # tarball contents
```

The smoke suite's `makeContext()` mock mirrors the real 0.2.1 service shapes
(`settings.describe/update`, `startActivation`, `jobs.start(owner:SessionId)`,
the `agent/request` waterfall via `runRequest`). When DSH changes a contract,
change the adapter **and** the mock together.

Live acceptance: install the bundle, open a session on the `tiered` preset,
`/tier status` should show `routing seam: waterfall`, `seams: all ok`, and
`config persisted: yes (host entry "tier-routing", writable)`.

## 11. v0.8.0 additions: smart mode, sidekick, advisor budget, TurboQuant

### Smart mode

- `mode: 'smart'` is a session/global mode. `tierNameFor` short-circuits the
  Main Agent (`!isChildAgent`) to the plan tier (`main` in three tiers, `strong`
  otherwise) regardless of plan state; failure escalation still outranks it.
- The `tools/pre-execute` guard denies `write`/`edit`/`multi_edit`/`patch` for
  the Main Agent in smart mode, pointing at `tier_sidekick`.

### Sidekicks

- `lib/core/sidekick.js` owns the stage registry (explore/implement/fix):
  system prompts, user-prompt builders (`buildUser`), and tolerant response
  parsers (`parseExploreSnippets`, `parseChangeReport`).
- `tier_sidekick` spawns a subagent via `startWorker` with `agentOptions` from
  `resolveSidekickTarget(stage, state)` (stage override or cheap tier). The
  child is recorded in the `childKeepSeed` WeakMap; `childRouteSource` returns
  `'keep'` for it, so the waterfall preserves the seeded stage model verbatim.
- Explore results are upserted into the TurboQuant cache; implement/fix results
  invalidate touched paths and index the change summary.

### Advisor budget

- `decideAdvisorBudget(callsInTurn, maxCalls, confirmTimeoutSec)` in
  `lib/core/policy.js`: `allow` below the limit, `ask` at the limit when
  confirmation is configured, `deny` otherwise.
- `tier_advisor.execute` counts per-agent calls in the `advisorTurnCalls`
  WeakMap, reset on `agent/inbox/inserted` user messages. The ask path uses the
  approval service (`ctx.get('approval')` → `ApprovalService.request`), which
  requires an open turn (a tool execute inside a turn qualifies) and returns
  `allowed-once | rejected | cancelled | unavailable`; only `allowed-once`
  proceeds, everything else fails closed. The timeout is
  `AbortSignal.any([exec.signal, AbortSignal.timeout(ms)])` — Node ≥ 20 only,
  which the declared engines guarantee.

### TurboQuant cache

- `lib/core/turbovec.js` is pure: `embedCodeText` (Signed Feature Hashing over
  paths/identifiers/trigrams/keywords/pairs, L2-normalized), `rotateVector`
  (deterministic sign scramble + FWHT), `createTurboQuantIndex` (16 Lloyd–Max
  levels of the standard normal, two coordinates per byte, LUT scoring, base64
  state export/import — hand-rolled, no Node globals).
- `lib/dsh/vec-cache.js` adapts `ctx.fs`: `resolve`/`readText`/`writeText`
  only (the fs contract has no delete/rename; cache clear = overwrite with
  empty state), 1s debounced saves of `.dsh-turbovec-cache.json`, and
  `readEvidencePaths` with per-file/total caps for `paths[]` evidence.
- Seams: `approvalRequest`, `fsResolve`, `fsReadText`, `fsWriteText` added to
  `probeServices` (optional: absence degrades the feature, never crashes).
- Cache safety: the cache file name is a compiled-in constant
  (`.dsh-turbovec-cache.json`), never derived from user input, and all writes
  go through `fs.resolve` against the captured workspace cwd, so containment is
  the mounted backend's job (fs-local/fs-sandbox). Corruption on import is
  handled per entry (wrong code length → entry skipped; unparsable JSON →
  cache starts empty); `maxEntries` bounds memory with oldest-first eviction.
  `paths[]` evidence reads are read-only and size-capped. Import validates
  every entry (dim, code length, decodable base64) and counts skipped/corrupt
  entries in `stats().importSkipped`, surfaced by `/tier cache status`, so a
  stale or damaged file degrades observably instead of silently.
- Threat model for the smart-mode write guard: enforcement is at the DSH
  execution seam (`tools/pre-execute`), not in the prompt — the Main Agent's
  `write`/`edit`/`multi_edit`/`patch` calls are denied at tool-execution time.
  Child sidekicks are intentionally allowed to write: that is the delegation
  contract (Main plans/reviews, sidekicks edit). An attacker who can fabricate
  a child tool call already controls the harness's own subagent pipeline; the
  plugin does not widen that surface.
- WebUI (`client/client.js`): `'smart'` in the mode enum, three sidekick route
  fields, `advisorMaxCallsPerTurn`, `advisorConfirmTimeoutSec`,
  `forceTierOnExplicitModel`.

### v0.8.1: digest cards, stable prompt prefixes, search scoping

- **Digest cards.** `createTurboQuantIndex().upsertDigest({stage, area,
  diffSummary, checks, issues})` stores a `kind:'digest'` entry keyed
  internally as `digest::<stage>::<area>` (path = canonical area). Cards are
  capped per stage (8, oldest evicted) and are skipped by
  `invalidateByPath` — a card describes a result, not a file, so file
  rewrites never remove them.
- **Stable prefixes.** Each sidekick stage has a fixed `STAGE_PREAMBLES`
  entry; `buildUser` assembles preamble → task → cards → snippets. Two calls
  within a stage share a byte-identical prefix (regression-tested), which is
  the necessary condition for provider-side prompt-cache reuse on fresh
  sessions. `formatCard` renders cards deterministically (no timestamps, no
  insertion-order numbering).
- **Search scoping.** `search` accepts `kindFilter`, `stageFilter`, and array
  `pathFilter`; tie-breaking is deterministic (path+lines). `tier_sidekick`
  uses `k:8` + `pathFilter` when `paths[]` is given, `kindFilter:'snippet'`
  at 0.12, and `kindFilter:'digest', stageFilter` at 0.12 for its memory
  cards. `diag.digestHits` counts card hits; `/tier cache status` reports
  snippets/digests/hits.
- **Cache format v2** with per-entry `kind`; v1 imports still load (all
  entries become snippets). `stats()` gains `snippets`/`digests`.
