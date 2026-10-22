# Code review log

This document records how a review pass over this plugin is run, what each
pass found, and what was decided. It is the durable counterpart of the
`[Unreleased]` CHANGELOG entries: the CHANGELOG says *what changed*, this file
says *why*, *what was rejected*, and *how to verify it again*.

Target host: **DSH `0.2.1-rc.2`** (developer preview). The mock suite mirrors
the shapes in `node_modules/@deepseek-ai/*` according to the pinned
`devDependencies` — a host upgrade means re-reading those `.d.ts` files, not
trusting this document.

---

## 1. How to run a review pass

```sh
npm run check                                        # syntax of every lib file
npm test                                             # 319 tests today
node --test --experimental-test-coverage "tests/**/*.test.mjs"
npm pack --dry-run                                   # packaged surfaces
```

What the pass looks at, in this order:

1. **Contract diff** — every DSH seam in `AGENTS.md` against the real `.d.ts`
   in `node_modules/@deepseek-ai/*` (event payloads, `LlmCallConfig`,
   `SessionHeader`, `FsWriteOutcome`, `ApprovalOutcome`, `ctx.effect`'s
   accepted shapes). A shape that moved is a one-file adapter fix by design.
2. **Coverage map** — uncovered lines in `lib/index.js` are the gap map: an
   uncovered listener/tool branch is where a routing or guard rule silently
   stops working. `routing-seam.js` at 67% was exactly such a hole.
3. **Static read** of `lib/index.js` against the golden rules in `AGENTS.md`
   (no DSH knowledge in `core/`, no decisions in `index.js`, per-agent state
   in `WeakMap`s, degrade instead of crash).
4. **Behavior probes** — a mock context that drives one suspicious path end to
   end, then a regression test for whatever it proves. Example (the probe that
   proved F1):

   ```js
   // ctx: settings.describe() -> { mode: 'smart', ... }, apply(ctx, { plane: 'agent' })
   const guard = ctx.listeners['tools/pre-execute'][0]
   const child = makeAgent('sidekick', 'subagent', { provider: 'cctq', model: 'gpt-5.6-terra' })
   await guard({ agent: child, name: 'bash', arguments: { command: 'rm -rf ./build' } }, async () => 'ran')
   // before: 'ran' (allowed, effective tier 'strong'); after: { kind: 'deny' }
   ```
5. **Dogfooded `tier_review`** — optional, advisory only. It sends the change
   set to the configured reviewer role. Two limits, both observed:
   whole files are truncated for a large change set (pass hunks in `evidence`
   instead of `paths`), and the tool parses a verdict from the first line, so
   a heading-first answer is reported as `UNPARSED`. Every claim it makes must
   be re-verified against the source before it is acted on.

---

## 2. Pass 1 — `[Unreleased]` (0.10.1 tree, 2026-10-22)

Scope: the whole tree. Baseline: 281 tests, 93.98% lines / 87.69% functions.
Result: 319 tests, 95.71% lines / 90.15% functions, `routing-seam.js` and
`decisions.js` at 100% / 98%.

### 2.1 Findings and dispositions

| # | Severity | Area | Finding | Disposition |
| --- | --- | --- | --- | --- |
| F1 | high | guard | A keep-seed child (every `tier_sidekick`) was classified `strong`, so the high-impact guard never fenced the agent that writes code on the cheap model | Fixed: weakest-of three routes (§2.2) |
| F2 | high | sidekick | The stage route is seeded verbatim, so `tier_sidekick` sent an undeclared `reasoningEffort` to the provider (`UNSUPPORTED_REASONING_EFFORT`) | Fixed: `reconcileTarget` before the spawn |
| F3 | high | sidekick | An unregistered stage provider failed deep inside the spawn with an opaque error | Fixed: validated with a `/tier set sidekick-<stage>` hint |
| F4 | high | plan mode | A plan/mode flip that happened before the plugin instance mounted was invisible → a resumed plan session planned on the cheap tier | Fixed: one-time fold of `session.ownEvents()` |
| F5 | high | config | A host-masked API key could be persisted back over the real key | Fixed: `isMaskedSecret` on read |
| F6 | medium | decisions | Cached decision replays consumed the per-turn budget, contradicting ARCHITECTURE | Fixed: `client.peek()` replay is budget-free |
| F7 | medium | decisions | `status().endpoint` read a `url` that only existed in another scope (a Node global leaked into the field) | Fixed: endpoint is a closure string |
| F8 | medium | decisions | The response cache was unbounded | Fixed: 256 entries, expired pruned, oldest dropped |
| F9 | medium | cache | An upsert between `createVecCache` and `load()` was wiped by the import | Fixed: `ensureVecCache` awaits the import; in-flight load tracked per root |
| F10 | medium | legacy seam | `request/header` recorded `reasoningEffort: undefined`, which the session append validation rejects — the route was silently dropped | Fixed: the field is omitted |
| F11 | medium | paths | `process.cwd()` was the turn's working directory before the first message (cache/evidence could target the install dir) | Fixed: `sessionRoot()` |
| F12 | medium | client | The decision-model catalog did not re-read after the endpoint was edited | Fixed: effect depends on base URL/path/query |
| F13 | medium | config | A stored `spawnPolicy: 'main'` was erased while the two-tier layout was active | Fixed: load path keeps a valid-but-inactive value |
| F14 | medium | routing | `mode: 'smart'` + `inherit` left children unrouted (seed = planning model) | Fixed: children execute on the weak tier (behavior change) |
| F15 | medium | routing | A child's tier pin could arrive after its first request (spawn race) → the first step ran on the wrong tier | Fixed: `pendingChildPins` claim + withdraw on failed spawn |
| F16 | low | config | `cordis.patch.yml` still carried the removed `strongFollowSession`/`cheapFollowSession` keys | Fixed: removed |
| F17 | low | docs | CHANGELOG 0.10.1 contained literal `\t`/`\f` control characters instead of backticks | Fixed |
| F18 | low | docs | `routing.js` still described "strong follows the session model" | Fixed |
| F19 | low | docs | Docs promised 8 digest cards per stage; the code keeps 16 | Fixed: docs say 16, the cap is exported as `DIGEST_MAX_PER_STAGE` and the test derives from it |
| F20 | low | docs | The `/tier cache` command list omitted the implemented `invalidate`, `export`, `gc` | Fixed in both READMEs |
| F21 | low | config | `Config.strongFallback` defaulted to `[]` while core/docs defaulted to a self-fallback entry | Fixed: schema default matches |
| F22 | low | docs | An orphaned JSDoc block sat above `parentAgentOf` | Fixed: attached to `resolveRoute` |
| F23 | low | repo | `.gitignore` missed the exported cache file (and local tool state) | Fixed |
| F24 | low | docs | `OPTIONAL_SEAMS` was documented without the approval/fs/sandbox entries | Fixed |
| F25 | low | status | The unused `defaultModel` seam produced a false `missing:` entry in `/tier status` | Fixed: seam removed |
| F26 | low | core | `index.js` duplicated `isDecisionStageEnabled` | Fixed: the core function is used |
| F27 | low | core | Three exported symbols had no reader (`ESCALATION_PHASES`, `sidekickTitle`, `DECISION_QUESTION_TYPES`) | Removed |
| F28 | low | effort | `nextEffortStep` did not understand `off` and reported "already at max" when no higher level existed | Fixed: `off` is the ladder floor; the message names the declared levels |
| F29 | low | pi mode | Seven tool definitions were built and then not registered in the minimal preset | Fixed: definitions are gated on `fullToolset` |
| F30 | low | fs tools | `minimal-fs-tools.policyFor` threw when the sandbox resolver threw | Fixed: falls back to the backend default |
| F31 | low | tests | Several adapter/tool paths had no coverage (`routing-seam` 67%, `subagents.start` 72%, `/advisor`, `/tier gate`, `decisions.status`) | Fixed: `tests/routing-seam.test.mjs` + new smoke cases |

### 2.2 The guard rule (F1), in detail

`effectiveExecutionTier()` now returns the **weakest** of the three tiers a
child could be executing on:

1. the route its **current step actually carried** — read from the logged
   `request/header` (or `agent.options` before that), because a tool call was
   produced by the model that answered that request, and a waterfall resolve
   failure falls back to the seed;
2. the tier **recorded at spawn** (`childRouteTiers`: the `tier_worker` pin or
   the sidekick stage route, normalized to a tier name — an unknown stage model
   is recorded as the weak tier);
3. the tier the **policy** would pick (`tierNameFor`).

An unknown route fails safe to the weak tier. A stronger intent therefore
never vouches for a step that may run on the cheap model. This is checked by
four regression tests (cheap sidekick denied, strong-pinned child allowed,
unknown route denied, pinned-but-actually-cheap child denied).

### 2.3 The child pin (F15), in detail

`tier_worker`/`tier_sidekick` announce `{ parentSessionId, provider, model,
tier }` **before** `startActivation`. The child's first request claims the
announcement in `resolveRoute` when its seed route matches (`parentId` +
provider + model), which sets the durable `childTiers` record. A dispatch that
fails withdraws the announcement; the array is bounded to 16 and entries
expire after five minutes. A regression test fires the child's first request
*inside* `startActivation` — before the tool resumes — and asserts the
announced tier.

### 2.4 Behavior changes a user may notice

- **Smart mode** now routes children of an inherited policy to the weak tier
  (smart mode delegates execution). An explicit `strong`/`main` policy still
  wins; escalation still outranks both.
- An **undeclared reasoning effort** now resolves to the nearest declared level
  rather than the model's floor: a strong tier asking for `max` on a
  `low|medium|high` model runs at `high`.
- An **explicit pin or session mode of an inactive tier** (`main` under two
  tiers) keeps the seed instead of falling through to the weak tier.
- A stored `spawnPolicy`/`forkPolicy` of `main` now **survives** the two-tier
  layout and becomes active again when the layout is switched.
- A **host-masked API key** is never written back.
- The documented **digest cap is 16** per stage (the code always was).

### 2.5 Rejected findings

| Finding | Why it was not changed |
| --- | --- |
| `cappedTier` fails open when the cap is unknown | The cap is always computed from the active layout (`state.threeTiers ? 'main' : 'cheap'`), so the unknown-cap branch is unreachable. A parent without a tier returns the parent route, which is the documented "keep the baseline" behavior and is tested. |
| Concurrent `tier_worker` spawns can "swap" pins by position | Pins are matched by parent session + provider + model, never by index. Two workers with different routes cannot swap; two workers with the same route resolve to the same tier either way. |
| "A failed resolve silently downgrades a strong child" | This is the F1 fix: the guard takes the weakest of the actual route, the recorded pin, and the policy, so a seed fallback cannot vouch for a stronger tier. Kept as a deliberate belt-and-braces rule, not a separate change. |

### 2.6 Known limitations and follow-ups

| # | Limitation | Impact |
| --- | --- | --- |
| L1 | `childTiers`, `childKeepSeed` and `childRouteTiers` are `WeakMap`s keyed on the agent object; a resumed child is a new object and loses the record | A resumed strong-pinned worker re-resolves through its policy tier; a keep-seed child keeps its seed either way. Not a routing hazard today, but persisting the pin (keyed by session id) would close it. |
| L2 | The decision response cache evicts FIFO (oldest inserted), not LRU | Acceptable for a 60 s TTL; documented instead of implemented. |
| L3 | On a host without the `agent/request` waterfall, the effort is fitted only from the already-cached model metadata (`reconcileTargetCached`) | A cold cache can still send an undeclared level through the legacy `request/header` path. |
| L4 | The client's `SettingsFormModel` integration is exercised against a stub | A primitive rename in the host would surface only at runtime in the settings page. |
| L5 | A dogfooded `tier_review` of a large change set is truncated and reports `UNPARSED` when the answer starts with a heading | Review log records it as advisory input; pass hunks in `evidence` and ask for a first-line verdict. |
| L6 | `pendingChildPins` is the only process-wide (non-`WeakMap`) state | Bounded (16) and expiring (5 min); documented as the one deliberate exception in `AGENTS.md`. |

### 2.7 Verification snapshot

| Check | Baseline | After pass 1 |
| --- | --- | --- |
| `npm test` | 281 pass | **319 pass, 0 fail** |
| `npm run check` | 20 files OK | 20 files OK |
| Line coverage | 93.98% | **95.71%** |
| Function coverage | 87.69% | **90.15%** |
| `lib/dsh/routing-seam.js` | 67.24% | **100%** |
| `lib/dsh/subagents.js` | 72.31% | **98.46%** |
| `lib/dsh/decisions.js` | 89.76% | **98.17%** |
| `npm pack --dry-run` | 29 files | 29 files |

New test files: `tests/routing-seam.test.mjs` (both routing strategies against
plain fakes). Existing suites gained regression cases for every finding marked
"Fixed" above.

---

## 3. Checklist for the next pass

- [ ] Re-read the pinned `.d.ts` set (`dsh-agent`, `dsh-llm`, `dsh-session`,
      `dsh-tools`, `dsh-fs`, `dsh-user-approval`, `cordis`). A changed event
      payload is a one-adapter fix, not a rewrite.
- [ ] Look at the coverage gap list first — uncovered listener branches are
      where a rule stops applying.
- [ ] Re-run the guard probe (§1 step 4) for any new child kind.
- [ ] Check that every documented number (digest cap, tool count, budget,
      cache bound) is derived from a constant, not copied into prose.
- [ ] Check that `Config`'s volatile fields, `applyPersisted`'s read list and
      `persistTierConfig`'s write list still agree (a three-way diff script
      takes seconds).
- [ ] If a new mode or policy action is added, extend `resolveTierSpec`'s
      precedence and its pure tests together.

---

## 4. Decision record — cache telemetry [Unreleased]

Scope: the prompt-cache lapse report behind `/tier cache status`. Packet A is
the pure analysis (`lib/core/cache-cost.js`); packet B is the adapter
(`lib/dsh/cache-telemetry.js`), the `index.js` wiring, the smoke cases and the
`ARCHITECTURE.md` §14 section. Nothing here changes routing.

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Telemetry first**: a passive, read-only `session/event` listener folds `assistant/message` timestamps into a bounded per-agent `WeakMap` timeline | The evidence already flows through the host, so the report costs **zero extra LLM spend and zero request changes**. It also degrades honestly: no observed events, no claim. |
| D2 | **R4 = recommend only**: the report may print one `cacheRetention: 'long'` hint, gated on `cacheMinLapses` attributable lapses and `cacheLapsesPerHourThreshold` | The plugin cannot act on the advice, so it must not imply it did. Both thresholds are config fields, so the gate is tunable, not baked into the wording. |
| D3 | Rejected: **keep-alive pings** while a child runs | The plugin cannot initiate an LLM request (only answer one the agent already made) — and a ping would be billed, for a cache entry the user did not ask to keep warm. |
| D4 | Rejected: **per-request `cacheRetention` / `cache_control` injection** | The field lives below this plugin's waterfall reach: `agent/request` rewrites provider/model/effort, not the provider-side cache block. An unverified write there would be a silent request mutation; the honest move is a recommendation applied in the user's own profile config. |
| D5 | **Child windows are timed in the handler** (`tier_sidekick` `attemptOn`, `tier_worker` `settleRun`), never folded from events | A child ran its own session, so the parent sees no event for the window; and a child's `assistant/message` steps must not be recorded into the main agent's timeline (the listener skips `isChildAgent`). `Date.now()` stays in `index.js`, keeping `core/` clock-free. |
| D6 | Four **flat** tariff fields (`cacheTariffPrompt` / `CacheRead` / `CacheWrite` / `Completion`, `-1` = not configured) instead of one nested object | Every durable field in this plugin is flat, so the settings page and `applyPersisted` handle it like the rest; the all-four-or-none rule stops a partial block from half-pricing a session (the report then counts tokens, not dollars). |

Verification: `npm test` **366 pass, 0 fail**; `npm run check` OK on 22 files
(the new `lib/dsh/cache-telemetry.js` included). New smoke cases: "cache
telemetry: main-agent steps and a past-ttl gap reach `/tier cache status`",
"cache telemetry: an empty timeline and a usage-less step degrade honestly",
"cache telemetry: child-session steps are never recorded on the main
timeline", "cache telemetry: sidekick and worker child windows are attributed
to the caller".
