# Changelog

All notable changes to dsh-tier-router are documented here.

## [0.9.0] - 2026-10-21

### Added

- **Pi-like minimal preset (`tiered-minimal`).** A second agent preset that
  mirrors Pi's minimal-prompt philosophy: a one-line persona, exactly the
  Pi-style tools `read` / `write` / `edit` (registered by this plugin with
  sparse schemas and no fs-observation-policy) plus the platform terminal
  (`bash` on POSIX, `pwsh` on Windows), context compaction, and plan mode on
  demand. Skills, jobs, schedule, goal, todo, web, present, ask-user,
  subagents/workflow, fs-search, and MCP are excluded; heavy guidance loads on
  demand via `tier_advisor` / `tier_review` / `tier_worker`. In this preset
  the `tier-routing` prompt section collapses to a few lines, including a
  hint telling the model to delegate tasks needing tools outside the minimal
  set via `tier_worker` with `agentPreset: tiered` (automatic heavy work from
  the minimal session). Host setting `promptProfile` documents the
  recommended default for new sessions.

## [0.8.1] - 2026-10-21

### Added

- **Digest cards (sidekick memory).** `upsertDigest` in the TurboQuant index
  stores the compact outcome of a completed sidekick stage per area
  (diffSummary + checks + issues), capped per stage (8, oldest evicted) and
  never removed by file invalidation (a card describes a result, not a file).
  `tier_sidekick` queries cards for its own stage and injects the top 3 into
  the prompt as `Previous outcomes (memory):` — the sidekick now "remembers"
  its prior work between calls without any session reuse.
- **Byte-stable prompt prefixes.** Each stage has a fixed preamble; the prompt
  assembles as preamble → task → cards → snippets. Repeated calls within a
  stage share an identical prefix (tested byte-for-byte), improving provider
 -side prompt-cache hits even on fresh sessions.
- **Search scoping.** `search` gained `kindFilter` (`snippet`/`digest`),
  `stageFilter`, and array `pathFilter`; results sort deterministically
  (score desc, then path+lines). `tier_sidekick` raises snippet `k` to 8 and
  scopes `pathFilter` to the given `paths[]`; snippet matching threshold
  relaxed to 0.12 so varying task phrasing still recalls relevant snippets.
- **Cache format v2** (version field, per-entry `kind`); v1 import and still
  supported and treated as snippets. `stats()` reports `snippets`/`digests`;
  `/tier cache status` and `/tier status` show both plus `digestHits`.

## [0.8.0] - 2026-10-21

### Added

- **Smart mode (`/tier smart`, `tier_route tier: "smart"`).** The Main Agent is
  pinned to the planning/architecture tier (`main` in the three-tier layout,
  `strong` otherwise) regardless of plan state, keeping its provider-side KV
  cache continuous. In smart mode the Main Agent cannot call `write`, `edit`,
  `multi_edit`, or `patch` directly — the pre-execute guard denies them with a
  pointer to `tier_sidekick`. File exploration and mutation are delegated to
  sidekick subagents spawned per stage on the stage model.
- **`tier_sidekick` tool.** Stages `explore` (returns compact `File snippets`),
  `implement` (writes code/tests/lint fixes), and `fix` (fixes bugs). Each stage
  runs on its configured model (`/tier set sidekick-<stage> <provider> <model>
  [effort]` or `reset`); the base route is the cheap tier. The sidekick is
  spawned with `startWorker` and its seed route is preserved verbatim through the
  new `childRouteSource` `keepSeed` branch. Explore results are indexed into the
  TurboQuant cache; implement/fix results invalidate touched files and index the
  change summary.
- **TurboQuant 4-bit snippet cache.** `lib/core/turbovec.js` embeds code text
  locally (Signed Feature Hashing, d=512, L2-normalized), rotates it with a
  deterministic FWHT, and stores 4-bit Lloyd–Max vectors (256 bytes per vector).
  `lib/dsh/vec-cache.js` persists the cache with a 1s debounce to
  `.dsh-turbovec-cache.json` via `ctx.fs` (in-memory only without a writable fs
  service). `/tier cache status|clear|search <query>`; `paths[]` evidence for
  `tier_advisor`/`tier_review` is read with caps and combined with top cached
  snippets.
- **Advisor per-turn budget.** `advisorMaxCallsPerTurn` (default 2) and
  `advisorConfirmTimeoutSec` (default 30) config fields. `tier_advisor` allows
  that many calls per user turn without asking; the next call asks through the
  approval seam (`ctx.approval.request`, outcomes `allowed-once` → proceed,
  anything else fails closed) with a 30s timeout, and denies when no approval is
  available. The budget resets on each user message.
- **`forceTierOnExplicitModel` (default off).** When on, subagent children with
  an explicit seed model are routed by tier/policy rules instead of keeping the
  seed (`childRouteSource` `forceTier` branch). Toggle with `/tier subagent
  force-explicit <on|off>` or the WebUI field.
- **Softer consultation parsing.** `softParseSections` extracts `risks`,
  `nextSteps`, `acceptanceChecks` (advisor) and `issues` (review) from JSON or
  Markdown section lists; `advice`/`review`/`verdict` stay fully backward
  compatible and the tool outputs expose the structured fields.

### Fixed

- `base64ToBytes` decoded unpadded input by dropping padding, which corrupted
  cache entries on import; it now pads its input before decoding.

## [0.7.1] - 2026-10-21

### Fixed

- **Sessions became unloadable after plan-mode switches and `/tier` commands.** In
  waterfall mode the plugin still appended `request/header` from listeners and
  commands (plan-mode flips, `/tier` routing changes). Between turns that header
  falls outside an open turn, and DSH then refuses to load the session
  (`request/header is outside an open turn`). Waterfall mode now writes nothing
  there: the loop logs the header itself. Legacy header mode is unchanged. A
  regression test covers the commands and the plan-mode flip.

## [0.7.0] - 2026-10-21

### Added

- **Two independent switches.** `/tier layout <two|three>` adds a `main` tier
  between strong and cheap: plan mode runs on main, execution on cheap, and
  strong becomes the escalation tier (failure auto-escalation, `/tier strong`,
  `tier_route`). The two-tier layout stays the default and behaves as before.
  `/tier roles <on|off>` gives advisor and reviewer their own models through
  `/tier set advisor|reviewer` or `tier_configure`; off, they use the strong
  route. A role has no fallback chain of its own and falls back to the strong
  chain. The main tier takes `followSession` like strong; the guard denies
  high-impact actions on the cheap tier only, as before.
- **Plan-exit gate.** While plan mode is active, `exit_plan_mode` is checked
  before the plan reaches you. First, the agent must have read or searched the code
  at least `planMinExplore` times (default 2, counted per plan with `read`, `glob`,
  `grep`); otherwise the call is denied with that reason and the agent explores
  and presents again. Second, when `planAdvisorGate` is on (default), the advisor
  reviews each plan once: its advice is returned to the agent as the denial, and
  the revised plan then goes to you. If the advisor is unavailable the plan
  proceeds without review. Set with `/tier gate explore <n>` and
  `/tier gate advisor <on|off>`. Verified with mocks only.
- **Separate policies for spawn and fork subagents.** `spawnPolicy` (the built-in
  `subagent` tool) and `forkPolicy` (`subagent_fork`) override the shared
  `subagentPolicy`; a blank override falls back to it. A child's kind comes from its
  session header (`isSeeded` marks fork lineage). Set with
  `/tier subagent spawn|fork <policy>` or `tier_configure`. Defaults stay `inherit`.
- **Policy `capped`.** The parent's route, but never above the cap tier: `main` in
  three tiers, `cheap` in two (there is no middle tier to cap at).
- **`caller` is for fork children only.** A spawn child starts with an empty
  conversation, so it gains no cache from the parent. A global `caller` makes spawn
  children use `inherit`.
- **Subagent policy `caller`.** `/tier subagent caller` (and `tier_configure`
  with `subagentPolicy: "caller"`) routes a subagent child on its parent's current
  route instead of the tier rules. The parent is found through the child's session
  lineage (`parentSession`).
- **Explicit subagent routes are kept.** When the caller of `subagent` picks a
  provider/model for a child, the router no longer overwrites that route on every
  request. The decision is taken once, on the child's first request: a seed that
  differs from the parent's route and is not one of the tier routes counts as
  explicit. Escalation after repeated failures still routes the child to strong,
  and tier_worker children keep their tier. Verified with mocks only.
- **Reviewer chain drift warning in `/tier status`.** A `review chain:` line
  names any reviewer fallback step that shares a model family with an
  implementer, because a failing reviewer would hand the verdict to a same-family model.
- **Form fields** in the WebUI tier form for the layout and roles switches, the
  main tier, and both role routes.
- **Reviewer independence warning in `/tier status`.** The review line shows the
  reviewer's model family and warns when an implementer (the cheap tier or the
  session model) shares it, since a same-family reviewer shares its blind spots.
  The family is the series token of the model id, so `deepseek-v4-pro` and
  `deepseek-v4-flash` match, and so do the same model served by two providers.

### Changed

- **A followed tier's explicit pair is the first fallback step.** When strong or
  main follows the session model, its explicit provider/model/effort is tried
  right after the session model, then the configured chain (duplicates dropped).
  This matches the `tier_configure` description; before, the explicit pair was
  never used while the session selection was available. Existing configurations
  gain one extra fallback attempt when the chain did not already contain it.
- **Routes shown in `/tier status`** include the effective chain (explicit pair
  first when followed) and the reviewer line reflects the role route when roles
  are on.

### Fixed

- **Consultations use the strong fallback chain.** `tier_advisor`, `/advisor`,
  `tier_review` and `/tier review` called the primary strong route only, so an
  unavailable model stranded them while the chain sat unused. They now try the
  primary route, then the strong chain, moving on for the same failures the main
  request path falls back on (quota, rate limit, unknown model, credentials,
  5xx, transport, unregistered provider). Context-size and other non-model
  failures stop at once. The consult answer names the route that served it.
- **An unregistered provider route is a fallback trigger.** `NO_ADAPTER` (the
  DSH llm code for a provider with no adapter) now moves both the main request
  path and consultations to the next chain entry.

## [0.6.3] - 2026-12-16

### Fixed

- **The model catalog could not be read in the Desktop**: the client called
  `ctx.remote.session.modelCatalog()` without declaring `remote.session` in its
  `inject` list, so every read failed with "cannot get property
  \"remote.session\" without inject" and the form fell back to free text. The
  client now declares it, as the session picker does, and a test pins the
  declaration.

## [0.6.2] - 2026-12-16

### Fixed (Desktop field report: empty model lists)

- **Model lists come from the session catalog, as the session picker does.** The
  form read `remote.llm` directly, which returned an empty provider list when the
  first read happened before the adapters registered, so every provider and model
  field fell back to free text. It now reads `remote.session.modelCatalog()`, the
  same answer the session model picker uses.
- **Empty and failed reads are not cached.** The catalog is re-read on open, on
  `llm/adapters-updated`, on `settings/document-updated`, on reconnect, and by a
  Refresh button. A ready catalog is kept in memory; concurrent loads share one read.
- **One grouped model dropdown per tier**: an `<optgroup>` per provider, labelled
  with the provider names from the catalog. Picking a model also resets an effort
  the new model does not declare.
- **Effort dropdown from the model's declaration**: the levels come from
  `reasoning.efforts` with the model's default marked. A model without reasoning
  support shows that instead of an input; a route the catalog does not list keeps
  a free-text level.
- **Status line with counts and provider failures**: "Providers: N · Models: M",
  the reason when the catalog is empty or unreadable, and each provider that could
  not list its models, with the Host's message.
- **"Route not listed"** switches a tier to separate provider and model inputs for
  routes outside the catalog (custom endpoints, unlisted OpenRouter models).

## [0.6.1] - 2026-12-16

### Fixed (Desktop 0.2.1-rc.2 field report)

- **Reasoning effort is fitted to the route before dispatch**: DSH rejects an
  undeclared effort (`UNSUPPORTED_REASONING_EFFORT`), and `deepseek-v4-flash`
  declares only `off`/`low`/`high`/`max` — the old `medium` cheap default made
  every cheap-tier request fail. The cheap tier now starts at `low`; the
  `agent/request` waterfall, `tier_advisor`/`tier_review`/`tier_worker` calls
  and the header fallback consult `llm.resolveModelInfo` (cached per route) and
  substitute the nearest declared level, or send no `reasoningEffort` at all for
  a model that declares no reasoning support (many OpenRouter routes). Pure
  logic: `reconcileReasoningEffort` in `lib/core/routing.js`; the cache lives in
  `lib/dsh/model-capabilities.js`.
- **The settings form now renders on the bundle page**: the browser half
  registered into `plugins.item`, which the Plugins page only renders for the
  shipped official settings pages — nothing appeared on `dsh-tier-router`'s own
  page. It now registers `plugins.bundle.config` (key `dsh-tier-router`) and
  `plugins.row.config` (key `dsh-tier-router#tier-routing`), so the form sits on
  the bundle page and the `tier-routing` component row opens it as a page.
- **Provider and model are picked from the live catalog**: the form reads
  `remote.llm.listProviders()` / `listModels()` and renders dropdowns, keeping a
  free-text mode for routes the catalog does not list (custom endpoints,
  unlisted OpenRouter models).
- **Slash-command results are visible in a fresh session**: a command writes no
  turn, so a brand-new session stays on the hero screen and its `command/done`
  node is invisible. The client now listens to `command/executed` and shows
  `/tier` and `/advisor` output in a dismissible floating panel (plus the
  expanded in-transcript renderer).

## [0.6.0] - 2026-12-16

### Changed (DSH 0.2.1-rc.2 compatibility)

- **Routing moved to the `agent/request` waterfall**: the router returns the
  routed `LlmCallConfig` for every model request, so tier switches apply to the
  current step (the old one-step delay is gone) and the loop writes
  `request/header` itself. A `request/header` write strategy remains as a
  capability-detected fallback for older runtimes.
- **Configuration moved to the host profile entry**: all tier fields are
  volatile members of the host-level `tier-routing` row's Config schema, so DSH
  renders the settings page automatically and persists edits through the
  profile patch. Agent-plane code reads/writes them through the `settings`
  service bridge; if `settings` is absent the plugin degrades to in-memory
  configuration and `/tier status` reports it.
- **Preset declared via `@deepseek-ai/dsh-agent-preset`**: `cordis.patch.yml`
  now carries a host config row plus a `preset-tiered` declaration listing the
  full 0.2.x standard roster plus the agent-plane `tier-routing-agent` row.
  The file-synced `agent-presets/` directory and `lib/preset-sync.js` are gone
  (DSH 0.2 no longer scans `~/.dsh/.agent-presets`).
- **Subagents use `startActivation`**: `tier_worker` starts workers through the
  new spec (`{provider, label, request, signal, delivery}`) and resolves the
  child agent via `agents.get(activation.childId)`; a legacy `start()` adapter
  remains for older runtimes.
- **`tier_worker` option changes**: `toolFilter` and `persona` were removed
  upstream — use `agentPreset` (requires a provider declaring preset support,
  e.g. `spawn`). `tier`, `outputSchema`, `maxDepth` and `background` are
  unchanged.
- **Jobs owner is a SessionId**: background workers pass `owner: session.id`.
- **Layered architecture**: pure decision logic lives in `lib/core/`
  (`tiers`, `routing`, `guard`, `policy`, `consult`, `metrics`) with no DSH
  imports or I/O; every harness contact point is isolated in `lib/dsh/`
  adapters (`services` probe, `routing-seam` strategies, `subagents`, `jobs`,
  `config` bridge). Future DSH breaking changes should land inside a single
  adapter file.
- **Startup capability probe**: `/tier status` reports the active routing seam
  and any missing capability; each feature degrades independently instead of
  failing the whole plugin.

### Roadmap (documented, not implemented)

- Opt-in decision-model adapter (Jev / Clef / OpenRouter Decisions API or a
  Jev-compatible self-hosted endpoint such as `laya-server`) feeding the
  reserved `ask` policy action, second-stage guard classification and
  worker/consult tier selection; deterministic policy remains the default.
- N named tiers via the `lib/core/tiers.js` registry.
- Additional consult registry entries (`delegate`, `diff-review`).

### Removed

- `lib/preset-sync.js`, `agent-presets/`, `client/client.js`, `tests/preset-sync.test.mjs`
- `dsh.client` metadata and `client`/`agent-presets` from `files`
- `tier_worker` parameters `toolFilter` and `persona` (removed upstream)

## [0.5.0] - 2026-08-24

### Added
- **Delegated routing mode**: the main agent stays on the DSH Web model-picker
  selection while only subagents are tier-routed. The global/session `mode` now
  persists as `auto | delegated | strong | cheap | off` (missing or invalid
  legacy values fall back to `auto`), exposed through `/tier delegated`,
  `tier_route({ tier: "delegated" })`, and the WebUI settings card's segmented
  control (自动 | 仅子代理 | 强模型 | 低成本 | 关闭). `/tier auto` is now an
  explicit per-session override so it can override a globally persisted
  delegated mode. Delegated main agents skip inbox/plan header rewrites and
  their errors do not trigger tier escalation or fallback; the high-impact
  guard stays active. Child precedence: explicit `tier_worker` tier, session
  override, escalation, subagentPolicy, then inherit (plan active -> strong,
  otherwise cheap).
- **Per-tier fallback chains**: strong and cheap each support an ordered list of
  fallback models. A model-availability failure (UNKNOWN_MODEL, QUOTA,
  RATE_LIMIT, MISSING_CREDENTIAL, INVALID_CREDENTIAL, SERVER, TRANSPORT, or a
  status >= 500 provider error) advances the agent's chain and writes the next
  model into the session header for the same task. The tier returns to its
  primary model after a 5-minute TTL (`state.fallbackTtlMs`), and a fresh chain
  is used after an exhausted chain clears. Fallback is per agent (subagent
  children included) and independent of failure auto-escalation.
- **Task-intensity reasoning effort**: the cheap tier starts at medium and
  raises itself one step (medium -> high -> max, bounded by the model's
  declared efforts) on cheap-tier retry errors, high-impact guard denials, or
  the new `tier_escalate_effort` tool; `/tier effort <medium|high|max>` sets it
  manually per session. The strong tier follows the session model selection by
  default (`followSession: true`).
- **Effort validation against `llm.resolveModelInfo(provider, model)`**:
  `reasoning.efforts` is enforced when available (cctq accepts low/medium/high,
  deepseek accepts off/high/max) and falls back to a lenient check when model
  metadata is unavailable.
- **New configuration surface**: `/tier set <tier> <provider> <model> [effort]
  [--fallback <p> <m> <e> ...]`, `/tier set strong follow-session`, and
  extended `tier_configure` parameters (`followSession`, `fallback`).
  `tier_configure` and `/tier set` accept any effort string and reject
  undeclared efforts with the available list.
- **Legacy settings migration**: old tier configs missing `followSession` /
  `fallback` are normalized silently (followSession default per tier; fallback
  mirrors the configured primary).
- **WebUI settings card** (new client bundle, `client/client.js`): a
  `settings.section` "Tier routing" page showing the live configuration and
  editing strong/cheap providers, followSession, fallback chains (one row per
  entry, pre-filled from the stored/default chain), subagentPolicy, and the
  routing mode — saved through the `tier-router` settings namespace and hot
  synced via `settings/document-updated`.
- **Model-catalog dropdowns**: provider -> model -> effort cascading selects
  fed by the host model catalog (`api.llm.models`); effort options come from
  each model's declared reasoning efforts. Values outside the catalog (custom
  routes) are kept as marked options; catalog failure falls back to free text.
- **Auto-activation polling**: the card silently re-probes every 4s while the
  namespace is unregistered (namespace registration emits no
  `settings/document-updated`), flipping to the live form the moment a tiered
  session registers it; polling stops once active.
- **`/tier` command result card**: a keyed `conversation.chat.commandview`
  entry renders `/tier` output fully expanded (the generic command card
  collapses multi-line output to a one-line summary), with success/running/
  failure states.
- **Automatic tiered preset discovery**: the profile bundle now mounts a
  host-only synchronizer. After `dsh plugin --profile web add dsh-tier-router`,
  DSH startup validates and synchronizes the packaged `tiered` preset into the
  user discovery root (`~/.dsh/.agent-presets` or `DSH_HOME/.agent-presets`).
  The host row never mounts routing tools; selecting `tiered` still mounts the
  agent-plane `tier-routing` row.
- **Preset description**: the tiered preset now describes fallback chains,
  task-intensity effort and the WebUI card (bilingual).

### Fixed
- **Initial and resumed routing**: synchronize the selected route into mutable
  AgentOptions before the loop builds a request, so the first request no longer
  discards a header written at inbox insertion.
- **Ordinary subagent routing**: `subagent` and `subagent_fork` now apply the
  configured child policy before their first request rather than only reporting
  that policy in diagnostics and the guard.
- **Fallback recovery**: availability failures now change route at
  `agent/request-error` and retry the same step. Fallback records carry their
  tier identity, so plan transitions cannot select a fallback from another tier;
  an explicit empty fallback array now disables fallback.
- **Escalation and headers**: child escalation obeys its TTL without overwriting
  a worker's explicit tier; route writes preserve unrelated request-header
  fields; delegated/off restore the session's captured route rather than the
  mutable global default.
- **WebUI integration**: the `/tier` command renderer now registers its required
  slot key, catalog failure permits free-form custom routes, and partial catalog
  failures are visible.
- `/tier status` printed a duplicate cheap-tier line (leftover from the
  fallback/effort status rewrite).
- Client bundle factory was missing `return module.exports`, breaking the
  browser harness boot ("invalid plugin ... received undefined").
- Fallback-chain editing crashed the settings panel white: `selectOrText` was
  called with a string where the locale function was expected, throwing
  `t is not a function` once the model catalog loaded.
- Settings card inputs were invisible on light themes: hard-coded dark
  fallback colors were replaced with the official `--dsw-*` theme aliases so
  the card follows light/dark themes automatically.

### Changed
- Defaults: strong = followSession with deepseek-official/deepseek-v4-pro@max
  fallback; cheap = cctq/gpt-5.6-terra@medium with
  deepseek-official/deepseek-v4-flash@high fallback.
- Success recovery is conservative: no LLM success event is emitted by the
  rc.7 agent loop, so a fallback stays active until its TTL expires and the
  next inbox write keeps the fallback header while the TTL is valid.
- Model fields are dropdowns backed by the model catalog instead of free text
  (custom values are preserved).

## [0.4.8] - 2026-08-16

### Fixed
- The inbox/plan/escalation listeners no longer rewrite headers of sessions
  the router does not manage: blank sessions are left to the host model picker,
  and a header for any manually selected provider/model is never overridden.
- Automatic routing now continues only after the plugin itself has established
  a tier header, or after an explicit `/tier strong|cheap|auto` opt-in; `off`
  still disables everything.
- This fixes the model-config mismatch that produced undefined
  provider/asyncIterator failures on new sessions when a manually selected
  model was being overwritten by tier routing.

### Added
- Regression tests: blank sessions and non-tier (manually selected) headers
  must not be rewritten by inbox routing.

## [0.4.7] - 2026-08-16

### Fixed
- Removed the `agent/request` waterfall listener: on DSH rc.6 an extra
  standing-scope waterfall listener makes model requests fail before reaching
  the adapter (the model-selection listener destructures the downstream result
