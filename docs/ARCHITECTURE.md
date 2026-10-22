# dsh-tier-orchestrator — Architecture

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
        │        active fallback chain entry? → chain target (chainFor: configured entries only)
        │        strong/main → explicit tier config (plugin settings only)
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
| `childTiers` | tier name | `tier_worker` after spawn (`agents.get(childId)`), or claimed from a pre-spawn announcement | `tierNameFor` (explicitTier) |
| `childRouteTiers` | tier name (worker) or the seeded route (sidekick) | `tier_worker`, `tier_sidekick` | `effectiveExecutionTier` — the guard classifies a keep-seed child by the route it actually sends, never as "strong" |
| `pendingChildPins` (array, bounded, 60s) | `{parentId, provider, model, tierName}` | `announceChildPin` before the spawn | `takePendingPin` on the child's first request (the spawn race) |
| `escalations` | `{count, windowStart, until}` | `agent/error` handler | `isEscalated` |
| `fallbackStates` | `{index, until, tierName}` | `agent/request-error` handler | `activeFallbackTarget` |
| `cheapEfforts` | `{effort, until}` | `raiseCheapEffort` | `currentCheapEffort` |
| `planStates` (keyed on **session**) | `boolean` | `session/event` listener (`plan/mode`), `setPlanMode`, and a one-time fold of `session.ownEvents()` on the first read for a resumed session | `planActive` — the real `Session` has no public `.events`, so we fold the stream ourselves; `session.events` is only a compat fallback (re-folded per read, never cached, because a mock/legacy array is mutable) |

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
`plane`, `mode`, `strong{Provider,Model,Effort,Fallback}`,
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
`explicit provider/model/effort` and a self-fallback entry; main =
`deepseek-official/deepseek-v4-pro@high` (inactive until
`threeTiers`); cheap = `deepseek-official/deepseek-v4-flash@low` with an empty
chain; roles off with no models; `subagentPolicy: 'inherit'`; `mode: 'auto'`.

**Chains.** `chainFor(tier)` is the one fallback list every path uses (request
waterfall, request-error retries, `/tier status`, consultations) — since
v0.10.1 it contains only the configured entries; the DSH session model picker
is never consulted for routing. Consultations walk `consultAttempts(role)`: the
role route when roles are on, then the strong route and its chain.

## 6. Tools and commands

| Surface | What it does |
| --- | --- |
| `tier_route` tool / `/tier strong|cheap|auto|delegated|off` | Per-session mode; `persist:true` also writes the session default via the plugin |
| `tier_configure` / `/tier set` | Re-point a tier (provider/model/effort/fallback chain) with `resolveModelInfo` effort validation; persists via settings |
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
  `presetRegister`, `approvalRequest`, `fsResolve`, `fsReadText`,
  `fsWriteText`, `fsEditText`, `fsStat`, `sandboxPolicy`) don't count as
  "missing" in the status line; subagents as a whole are flagged only when
  *neither* API exists. A probed seam that no feature reads is a bug: it
  reports a false degradation, so every entry here has a consumer.

`/tier status` prints `routing seam: waterfall|header` and `seams: all ok` or
the missing list — the first thing to check when debugging on a new DSH build.

## 8. The preset row (`cordis.patch.yml`)

Two `- insert:` rows:

1. `id: tier-routing / name: dsh-tier-orchestrator` — host config row (volatile
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
- **Decision models (Jev/Clef/…)**: implemented — see §13. The pure core
  (`lib/core/decision.js`) and the transport (`lib/dsh/decisions.js`) are
  separate layers; adding another stage is wiring one `askDecision` call into
  the seam that owns the decision.
- **Custom settings UI**: the `settings.section` UI slot still exists in 0.2;
  a hand-built card (provider→model→effort cascading selects) can replace the
  generated page later without changing the volatile schema.

## 10. Testing and verification

```sh
npm test           # pure core tests + mocked-context smoke + packaging checks
npm run check      # syntax check every lib file
npm pack --dry-run # tarball contents
```

| File | What it covers |
| --- | --- |
| `tests/pure.test.mjs` | `core/` only, no mocks (routing specs, guard patterns, escalation, decision parsing, TurboQuant) |
| `tests/smoke.test.mjs` | the whole plugin on a mocked ctx: every tool, command, listener, persistence path |
| `tests/routing-seam.test.mjs` | both routing strategies against plain fakes (waterfall replacement, legacy `request/header`) |
| `tests/decisions.test.mjs` | decision transport with an injected `fetch` (thresholds, cache/peek/bound, failures) |
| `tests/vec-cache.test.mjs` | cache persistence, trimming, export, stale-file sweep |
| `tests/minimal-fs-tools.test.mjs` | Pi-style read/write/edit semantics |
| `tests/client.test.mjs` | the browser half under Node with stubbed `react`/primitives |
| `tests/packaging.test.mjs` | manifest/patch integrity |

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
- Smart mode delegates *execution*, so a child under an inherited subagent
  policy runs on the weak tier (`resolveTierSpec`), never on the planning tier.
- The `tools/pre-execute` guard denies `write`/`edit`/`multi_edit`/`patch` for
  the Main Agent in smart mode, pointing at `tier_sidekick`.
- The guard's tier for a child is the **weakest** of: the route its current
  step actually carries (the tool call came from that model, even when a
  waterfall resolve failed and the seed was used), the tier recorded at spawn
  (`childRouteTiers`, which covers the window before the first routed
  request), and the tier the policy would pick. An unknown route fails safe to
  the weak tier. A stronger intent therefore never vouches for a step that may
  run on the weak tier — treating a keep-seed child as "strong" used to
  disable the guard for the very sidekick that edits code on the cheap model.
- A `tier_worker` pin announced before the spawn (`pendingChildPins`, bounded
  to 16, 5-minute TTL) is claimed by the child's first request whose seed
  matches the announced route; a failed spawn withdraws it. The pin is only a
  claim ticket — the durable record is the `childTiers` WeakMap, which a
  resumed child (a new agent object) no longer has, so it falls back to the
  policy (documented limitation, not a routing hazard: the seed is preserved).

### Sidekicks

- `lib/core/sidekick.js` owns the stage registry (explore/implement/fix):
  system prompts, user-prompt builders (`buildUser`), and tolerant response
  parsers (`parseExploreSnippets`, `parseChangeReport`).
- `tier_sidekick` spawns a subagent via `startWorker` with `agentOptions` from
  `resolveSidekickTarget(stage, state)` (stage override or cheap tier). The
  child is recorded in the `childKeepSeed` WeakMap; `childRouteSource` returns
  `'keep'` for it, so the waterfall preserves the seeded stage model verbatim.
- Because that seed is preserved verbatim, the route never passes the child's
  own request router: the tool fits its effort through `reconcileTarget`
  before spawning (an undeclared level would otherwise reach the provider as
  `UNSUPPORTED_REASONING_EFFORT`) and refuses an unregistered stage provider
  with a message that names `/tier set sidekick-<stage>`.
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
  capped per stage (`DIGEST_MAX_PER_STAGE`, 16, oldest evicted) and are skipped by
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

## 12. v0.9.0 additions: the `tiered-minimal` preset and `promptMode`

### Preset split

- `cordis.patch.yml` gains a third row, `preset-tiered-minimal`
  (`@deepseek-ai/dsh-agent-preset`, id `tiered-minimal`, order 30): persona
  one-liner (`complete: true`, `includeRuntimeContext: false`), a persistent
  platform terminal group (`dsh-terminal` + `dsh-terminal-bash` +
  `dsh-tool-bash-persistent` on POSIX, `shellDialect: pwsh` +
  `dsh-tool-pwsh-persistent` on Windows), compaction, plan mode on demand,
  and the agent-plane `tier-routing` row with `promptMode: pi`.
- Excluded roster: skills, jobs, schedule, goal, todo, web, present,
  ask-user, subagents/workflow, fs-search, plugin-manager/market, MCP.

### `promptMode` (agent row, non-volatile)

- `Config.promptMode: 'standard' | 'pi'` is set per preset; the host-row
  `promptProfile` field is informational only (recommended default for new
  sessions) and is not read by routing.
- `lib/core/prompt-section.js` builds the `tier-routing` system-prompt
  section: `standard` emits the full guidance block; `pi` collapses to a few
  lines — tier names, the current mode, and a hint to delegate tasks needing
  tools outside the minimal set via `tier_worker` with `agentPreset: tiered`.

### Tool surface in pi mode

- In `promptMode: 'pi'` only `tier_worker` is registered. The other seven
  `tier_*` tools (`tier_status`, `tier_advisor`, `tier_review`, `tier_route`,
  `tier_configure`, `tier_escalate_effort`, `tier_sidekick`) are gated by
  `const fullToolset = promptMode !== 'pi'` in `lib/index.js`: every
  registered tool adds its definition to every request (all eight measured
  at ~10.7K characters, ~3K tokens).
- The guard denial and the smart-mode denial name `tier_worker` in pi mode,
  because the tools they used to point at are not declared there.

### Filesystem writes carry the caller's sandbox policy

- The sandboxed `ctx.fs` backend fences every mutation with the CALLING
  session's policy — mode plus workspace root — passed as the last argument
  of `writeText`/`editText`. A caller that omits it falls back to the
  deployment default, which ignores the session's own mode (a subagent's
  `danger-full-access`, granted by delegation, included) and the session
  workspace root, so writes into the project are refused.
- `lib/minimal-fs-tools.js` and `lib/dsh/vec-cache.js` therefore resolve the
  policy through the new `sandboxPolicy` seam (`ctx.sandboxPolicy`,
  `resolve({ session })`) and pass it with every mutation, exactly like
  DSH's own `write`/`edit` tools do. Without it the TurboQuant cache file
  was refused as well, so the cache never persisted.

### `lib/minimal-fs-tools.js`

- Only mounted when `promptMode === 'pi'` **and** the fs seams exist
  (`fsResolve`/`fsReadText`/`fsWriteText`/`fsEditText`, the last added to
  `OPTIONAL_SEAMS` in this release). Registers Pi-shaped `read` / `write` /
  `edit` with sparse schemas and no fs-observation-policy (an edit does not
  require a prior read; `edit` accepts a list of disjoint replacements).
- All file access goes through the mounted `ctx.fs` backend — containment is
  the harness's job, as with the TurboQuant cache.

## 13. v0.10.0 additions: decision-model stages (Jev / System One / OpenRouter Decisions)

### The two layers

- `lib/core/decision.js` (pure, unit-tested): question builders
  (`buildGuardQuestions`, `buildTierQuestion`, `buildEscalationQuestion`,
  `buildConsultQuestion`), the strict response parser `parseDecisionAnswers`
  (a missing/out-of-range/unknown answer is an error, never a silent
  "approved"), threshold mapping `decideByThresholds`
  (approve/block/review/unknown), and `decisionKey` (cache identity).
- `lib/dsh/decisions.js`: the transport client. POSTs
  `{ model, state, questions }` to the OpenRouter Decisions API
  (`/api/alpha/decisions`, configurable base URL + path — any
  Jev-compatible endpoint works) with bearer auth when an API key is set,
  aborts on timeout (`AbortSignal.timeout`), parses through the core parser,
  caches identical-state responses for 60s, and returns `{ ok: false }` for
  every failure — it never throws. `fetchImpl` is injectable for tests.

### Configuration

Volatile host-row fields: `decisionModel`, `decisionBaseUrl` (empty →
https://openrouter.ai), `decisionPath` (default /api/alpha/decisions),
`decisionApiKey`, `decisionStages` (enable list over
`guard | escalate | worker | consult`), `decisionApproveAt` /
`decisionBlockAt` thresholds, `decisionTimeoutMs`, `decisionBudgetPerTurn`.
No model configured → every stage off → deterministic behavior unchanged.

All of them are editable in the WebUI: the plugin's bundle page and the
host-row page (`plugins.bundle.config` / `plugins.row.config` in
`client/client.js`) render a **Decision model** section — model id, base URL,
endpoint path, a masked API key, the enabled stages as checkboxes
(`guard | escalate | worker | consult`), the approve/block thresholds, the
request timeout and the per-turn call budget. The form validates the
thresholds and the numbers before they are written, and filters the stage
list to the known stages; the client keeps its own copy of the stage list and
the test suite asserts it matches `DECISION_STAGES` in `lib/core/decision.js`.
### The decision-model catalog

The decision model is not a chat model: the endpoint that answers the
questions lists its decision models in its own model catalog. OpenRouter
publishes them under `/api/v1/models?output_modalities=decisions` (Jev, Clef,
Drex, the Perplexity Decider, ...). The list is public, so the browser reads it
directly — with CORS headers and without the API key of the decision endpoint.
Two volatile fields point the picker elsewhere: `decisionCatalogPath` (default
`/api/v1/models`) and `decisionCatalogQuery` (default
`output_modalities=decisions&limit=100`).

The query parameter is not documented by OpenRouter, so the client filters the
answer as well: a model is a decision model when its
`architecture.output_modalities` contains `decisions`. Entries without that
field are kept but marked as unverified, so an endpoint that reports nothing
still works without pretending the catalog confirmed them. A model the catalog
does not list stays selectable, and the field falls back to free text when the
catalog is empty or unreachable. The read is keyed by the URL: a response that
arrives after the endpoint changed is dropped, and the new URL is read next.

The client-side bounds mirror the clamps of `lib/index.js`
(`decisionApproveAt`/`decisionBlockAt` in [0, 1], `decisionTimeoutMs` >= 500,
`decisionBudgetPerTurn` >= 0) and an out-of-range value is reported as invalid
instead of being written and clamped later. The API key is masked in the form
and can be revealed or cleared there; a host that masks the stored key is
detected and reported rather than shown as if it were the key. The mask never
enters the staged text either, so a masked value cannot be written back over
the real key. The key is stored in plain text in the profile entry and still
reaches the browser, so the WebUI is a trusted surface. The form also reports a
non-https endpoint, stages selected without a model, and an approve threshold
below the block threshold.

### Where decisions plug in (all async seams)

| Stage | Seam | Question(s) | Override semantics |
| --- | --- | --- | --- |
| `guard` | `tools/pre-execute`, after a deterministic high-impact deny | reversible, within_project, serves_task (noul) | only outcome `approve` allows; anything else keeps the deny (fail-closed) |
| `escalate` | `agent/error`, when the escalation threshold is reached | model_fault (noul) | only outcome `block` skips escalation (record stays counting); approve/review/unknown escalate as before |
| `worker` | `tier_worker` / `tier_sidekick` when no tier/stage override is given | tier choice (choice + confidence) | only `approve` with a valid, registered candidate switches the route |
| `consult` | `runConsult` (advisor/review/plan-exit gate) | needs_consult (noul) | outcome `block` returns a `skipped` result; callers render it without streaming |

### Safety properties

- The deterministic policy is always the fallback: no model, no key, budget
  spent, network error, timeout, or malformed answer → `null` from
  `askDecision` → the caller keeps its prior behavior.
- A decision model never *broadens* the deterministic layer except through an
  explicit full `approve`; guard approval requires every noul proposition ≥
  `approveAt`.
- Per-agent per-turn budget (`decisionTurnCalls`, reset on user messages)
  mirrors the advisor budget and counts real calls only. A state that a
  previous call already answered is served through `client.peek()` (no
  network) and does not spend the budget, even after it is exhausted; the
  response cache itself is bounded (`maxCacheEntries`, 256) and drops its
  oldest entries, so a long session cannot grow it without limit.
- A host that masks secrets in `settings.describe()` cannot corrupt the
  profile: `isMaskedSecret` (the server twin of the browser check) keeps a
  masked value out of `state`, so a later persist writes the old key, not the
  mask.
- Strict parsing: out-of-range probability, unknown choice option, missing
  answer, or non-JSON response is an error, never a silent "approved".
- A `choice` answer that carries no `confidence` is read from its
  `probabilities` map — but only the probability of the option it chose: the
  loudest neighbour never turns an answer into an approval. A `score` answer
  without a `score` falls back to its `confidence`. The endpoint may send
  either, and both have to reach the thresholds. A probability is only a
  number in [0, 1]: a string, a boolean or a value out of range counts as no
  probability, never as an approval.
- Never on the per-request hot path (`agent/request` is untouched).

## 14. Review log

`docs/REVIEW.md` records how a review pass is run (contract diff against the
pinned `.d.ts`, coverage-driven gap hunt, mock probes, the dogfooded
`tier_review` and its limits), every finding with its disposition, the
behavior changes users may notice, the findings that were rejected and why, and
the known limitations that were documented instead of fixed. Read it together
with the `[Unreleased]` CHANGELOG section: the CHANGELOG says what changed,
the review log says why and how to verify it again.