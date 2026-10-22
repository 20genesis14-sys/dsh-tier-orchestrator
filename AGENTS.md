# AGENTS.md — working contract for LLM agents on this repo

You are editing **dsh-tier-orchestrator**, a DeepSeek Harness (DSH) Cordis plugin that
routes model requests between a strong tier (planning/review) and a cheap tier
(implementation). Target host: **DSH `0.2.1-rc.2`** (developer preview — APIs
change between releases; capability-probe everything).

## Commands

```sh
npm test          # node --test tests/**/*.test.mjs  (pure logic + mocked-context smoke)
npm run check     # node --check on every lib file
npm pack --dry-run # verify tarball contents before publishing
```

Node `^22.19 || >=24`. No build step — plain ESM (`"type": "module"`).

## Golden rules

1. **`lib/core/` never imports DSH and never does I/O.** Plain objects in,
   decisions out. If you write `import ... '@deepseek-ai/...'` there, stop.
2. **`lib/dsh/` is the only place that knows DSH exists.** A harness API change
   should be fixable inside one adapter file. Every adapter degrades: missing
   service/event → feature off + honest status line, never a crash.
3. **`lib/index.js` is wiring, not logic.** Decisions belong in `core/`; DSH
   calls belong in `dsh/`. New code in `index.js` should mostly be
   `safeRegister(...)` calls gluing the two.
4. Two config planes: `plane: 'host'` (durable volatile fields → WebUI
   settings page, profile persistence) and `plane: 'agent'` (the preset row
   that mounts tools/commands/listeners). `apply()` gates on it.
5. State is per-agent via `WeakMap` (`sessionModes`, `escalations`,
   `fallbackStates`, `cheapEfforts`, `sessionBaselines`, `childTiers`,
   `childRouteTiers`, `childKeepSeed`, `planGates`, ...) — do not introduce
   global maps keyed by session id strings. The one deliberate exception is
   `pendingChildPins`, a bounded, expiring array of spawn announcements that
   the child's first request claims (it exists because the child can start
   before the caller resumes).
6. Don't break the tests' mocked contracts; they mirror the real DSH .d.ts
   shapes. If DSH changes shape, update the adapter AND the mock.

## How DSH APIs are used (adapter map)

| DSH seam | Adapter / usage |
| --- | --- |
| `ctx.get(name)` | `lib/dsh/services.js` `probeServices()` → `seams` capability map |
| `agent/request` waterfall | `lib/dsh/routing-seam.js` `mountRequestWaterfall` — primary routing seam |
| `request/header` append | `lib/dsh/routing-seam.js` `applyHeaderRoute` — legacy fallback strategy |
| `settings.describe/update` | `lib/dsh/config.js` `createConfigBridge` (ns `tier-routing`) |
| `subagents.startActivation` / `.start` | `lib/dsh/subagents.js` `startWorker` |
| `jobs.start` (owner = SessionId) | `lib/dsh/jobs.js` `startBackgroundJob` |
| `tools/pre-execute`, `agent/error`, `agent/request-error`, `agent/inbox/inserted`, `session/event` (plan/mode fold), `settings/document-updated` | listeners in `lib/index.js` |
| `llm.resolveModelInfo` (reasoning efforts) | `lib/dsh/model-capabilities.js` cached probe + `reconcileReasoningEffort` in `lib/core/routing.js` |
| Client slots `plugins.bundle.config` / `plugins.row.config` / `shell.overlay` / `conversation.chat.commandview` | `client/client.js` (browser half, `__ModuleLoader__` factory) |
| `session.modelCatalog` (model lists in the form) | `client/client.js` `createCatalog` — the same answer the session picker reads; never read `remote.llm` for lists |

## How to add a feature

- **New tier** → `lib/core/tiers.js` registry + Config volatile fields in
  `index.js` + `TIER_ORDER`.
- **New consultation** (`delegate`, `diff-review`…) → add an entry to
  `lib/core/consult.js` `CONSULTS` + one `defineTool` in `index.js`.
- **New policy action** (`ask`, …) → `lib/core/policy.js` vocabulary comment +
  the decision functions; wire the action in `index.js`.
- **New DSH seam usage** → probe it in `services.js`, wrap it in a `dsh/`
  adapter, gate the feature on the seam flag.
- **New UI control** → `client/client.js`; a bundle's form belongs in
  `plugins.bundle.config` (key = package name) and a row's page in
  `plugins.row.config` (key = `<package>#<rowId>`). `plugins.item` is taken by
  the shipped official settings pages — do not register there.
- **Anything that can fail with `UNSUPPORTED_REASONING_EFFORT`** → fit the
  effort through `reconcileReasoningEffort` before dispatch (undeclared level →
  nearest declared; no reasoning metadata → omit the field entirely).
- **Decision models (Jev/Clef/OpenRouter Decisions)** → `lib/dsh/decisions.js`
  (transport) + `lib/core/decision.js` (pure logic). Add a stage by wiring one
  `askDecision` call into its seam; deterministic policy stays the fallback.

## Testing conventions

- `tests/pure.test.mjs` — `core/` only, no mocks.
- `tests/smoke.test.mjs` — full plugin against a mocked ctx (`apply(ctx,
  { plane: 'agent' })`); mocks live in `makeContext()` and mirror real service
  shapes; `runRequest()` simulates the `agent/request` waterfall.
- `tests/packaging.test.mjs` — manifest/patch integrity.
- `tests/routing-seam.test.mjs` — both routing strategies against plain
  fakes (waterfall replacement, the legacy `request/header` write).
- `tests/decisions.test.mjs` — the decision-model transport (cache, peek,
  thresholds, failures) with an injected `fetch`.
- `tests/client.test.mjs` — the browser half, executed under Node against
  stubbed `react`/primitives.
- Keep tests free of `@deepseek-ai/*` imports where possible (they're devDeps;
  `index.js` itself imports `dsh-tools` + `schemastery`).

## Docs for humans

`docs/ARCHITECTURE.md` — full internals guide (data flow, state machines,
config schema, seam strategy selection, extension recipes). Read it before
non-trivial work.

`docs/REVIEW.md` — the review log: how a pass is run, every finding with its
disposition, rejected findings with reasoning, and the known limitations. Read
it before starting a review or when a behavior looks intentional but odd.
