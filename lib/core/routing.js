// Tier routing decisions — pure logic, no harness imports, no I/O.
//
// Everything here is a function of plain data (decision specs, tier configs,
// failure shapes) so it stays unit-testable with `node --test` and portable
// across harness API generations.

// Mirrors TIER_ORDER in ./tiers.js, which imports this module (a static import
// here would close the cycle). Only used to tell "a tier of an inactive
// layout" apart from a mode keyword.
const TIER_NAMES = ['strong', 'main', 'cheap']

/**
 * Resolve the effective tier for one step from a plain decision spec.
 * @param spec
 *   explicitTier:  per-agent explicit tier name (e.g. from tier_worker).
 *   sessionMode:   per-session override ('auto' | tier name |
 *                  'delegated' | 'off' | 'smart'); 'off' opts the session out
 *                  of all routing, while 'delegated' keeps the main agent on
 *                  its session default.
 *   escalated:     whether failure auto-escalation is active.
 *   isChild:       whether the agent is a subagent child.
 *   subagentPolicy: 'inherit' | tier name.
 *   mode:          'auto' | tier name | 'delegated' | 'off' | 'smart' (global
 *                  default).
 *   planActive:    whether plan mode is active for the agent.
 *   tiers:         known tier names (default ['strong', 'cheap']).
 * @returns a tier name, or null (no routing decision, e.g. mode off).
 */
export function resolveTierSpec(spec) {
  const tiers = Array.isArray(spec.tiers) && spec.tiers.length > 0 ? spec.tiers : ['strong', 'cheap']
  const first = tiers[0]
  const last = tiers[tiers.length - 1]
  // Three tiers: plan mode runs on the middle tier (main); strong is then
  // reached only by escalation or an explicit pin.
  const planTier = tiers.length > 2 ? tiers[1] : first
  if (spec.sessionMode === 'off') return null
  const delegated = spec.sessionMode === 'delegated'
    || (spec.sessionMode === undefined && spec.mode === 'delegated')
  if (delegated && !spec.isChild) return null
  // Failure escalation outranks explicit pins (both tier_worker child tiers
  // and session modes): repeated errors temporarily promote to the strong
  // tier and expire with the TTL — the explicit pin is not rewritten, the
  // escalation just sits above it while active (v0.4.x behavior).
  if (spec.escalated) return first
  // An explicit pin or session mode naming a tier of the *inactive* layout
  // (main under two tiers) is not a licence to downgrade to the weak tier:
  // it resolves to no decision, so the seed/baseline stays in force.
  if (spec.explicitTier) {
    if (tiers.indexOf(spec.explicitTier) !== -1) return spec.explicitTier
    if (TIER_NAMES.indexOf(spec.explicitTier) !== -1) return null
  }
  if (spec.sessionMode && TIER_NAMES.indexOf(spec.sessionMode) !== -1) {
    return tiers.indexOf(spec.sessionMode) !== -1 ? spec.sessionMode : null
  }
  if (spec.sessionMode && tiers.indexOf(spec.sessionMode) !== -1) return spec.sessionMode
  if (spec.isChild && spec.subagentPolicy && spec.subagentPolicy !== 'inherit' && tiers.indexOf(spec.subagentPolicy) !== -1) return spec.subagentPolicy
  // Smart mode is execution delegation: the main agent stays on the plan tier
  // (resolved by the caller), so a child under an inherited policy is work and
  // runs on the weak tier — it never inherits the planning tier.
  const smart = spec.sessionMode === 'smart' || (spec.sessionMode === undefined && spec.mode === 'smart')
  if (smart && spec.isChild) return last
  if (delegated && spec.isChild) return spec.planActive ? planTier : last
  if (spec.sessionMode === 'auto') return spec.planActive ? planTier : last
  if (spec.mode && tiers.indexOf(spec.mode) !== -1) return spec.mode
  if (spec.mode === 'auto') return spec.planActive ? planTier : last
  return null
}

/**
 * Where one subagent child's request route comes from.
 * @param spec
 *   pinned:         the child was started by tier_worker with an explicit tier.
 *   escalated:      failure escalation is active for the child.
 *   keepSeed:       the child's seed route must be preserved verbatim
 *                   (sidekick children carry their stage model in the seed).
 *   explicit:       the caller chose the child's route at creation.
 *   forceTier:      ignore an explicit route (forceTierOnExplicitModel): the
 *                   child is routed by tier/policy rules instead of keeping
 *                   the seed.
 *   policy:         the child's policy ('inherit' | 'strong' | 'cheap' | 'main' |
 *                   'caller' | 'capped').
 *   hasParentRoute: the parent's current route is known.
 * @returns 'tier' (the tier decision), 'keep' (leave the seed: an explicit
 *   route the caller chose), 'parent' (the parent's current route), or
 *   'capped' (the parent's route, never above the cap tier).
 *   Escalation and tier pins outrank an explicit route, so a failing explicit
 *   child still reaches the strong tier.
 */
export function childRouteSource(spec) {
  if (spec.escalated || spec.pinned) return 'tier'
  if (spec.keepSeed) return 'keep'
  if (spec.explicit && !spec.forceTier) return 'keep'
  if (spec.hasParentRoute && spec.policy === 'caller') return 'parent'
  if (spec.hasParentRoute && spec.policy === 'capped') return 'capped'
  return 'tier'
}

/**
 * The tier a child gets under the "capped" policy: the parent's tier, but
 * never stronger than the cap tier.
 * @param parentTier - the parent's tier name (null when it has none).
 * @param capTier    - the tier the child may not exceed (e.g. 'main').
 * @param order      - active tier names, strongest first.
 * @returns the parent's tier, or the cap tier when the parent is stronger.
 */
export function cappedTier(parentTier, capTier, order) {
  const p = order.indexOf(parentTier)
  const c = order.indexOf(capTier)
  if (p === -1 || c === -1) return parentTier
  return p < c ? capTier : parentTier
}

// ---- fallback chains & task-intensity effort -------------------------------

/**
 * Error codes that mean "this model route is unusable right now" and justify
 * switching to the next model in the tier's fallback chain. Network/5xx
 * provider failures are normalized to these codes by the adapters; a raw
 * status >= 500 failure is classified the same way as a belt-and-suspenders.
 */
export const FALLBACK_TRIGGER_CODES = ['UNKNOWN_MODEL', 'QUOTA', 'RATE_LIMIT', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER', 'SERVER', 'TRANSPORT']

/**
 * Error codes that must NOT switch models: they are not model-availability
 * problems (context size, a config-level effort mismatch, caller aborts, or a
 * degenerate empty response that DSH's own retry already handles).
 */
export const FALLBACK_IGNORE_CODES = ['CONTEXT_WINDOW_EXCEEDED', 'UNSUPPORTED_REASONING_EFFORT', 'ABORTED', 'EMPTY_RESPONSE']

/**
 * Classify one model-step failure for the fallback machinery.
 * @param failure - the failure shape { message, code, status, requestId, ... }.
 * @returns 'fallback' (switch to the next chain entry), 'ignore' (do not touch
 *   the chain; DSH retry / user action owns it), or 'escalate' (unknown shape -
 *   keep the original failure auto-escalation behavior).
 */
export function classifyFallback(failure) {
  if (!failure || typeof failure !== 'object') return 'escalate'
  if (typeof failure.code === 'string') {
    if (FALLBACK_TRIGGER_CODES.indexOf(failure.code) !== -1) return 'fallback'
    if (FALLBACK_IGNORE_CODES.indexOf(failure.code) !== -1) return 'ignore'
  }
  if (typeof failure.status === 'number' && failure.status >= 500) return 'fallback'
  return 'escalate'
}

/**
 * Validate a reasoning effort against the efforts a model actually declares
 * (resolveModelInfo().reasoning.efforts, each { id, name } or a plain id).
 * An empty/unknown declaration list is treated leniently: nothing is rejected
 * because the metadata could not be obtained.
 * @returns { ok, available } - available is the declared effort id list
 *   (empty when metadata was unavailable).
 */
export function validateReasoningEffort(effort, declaredEfforts) {
  if (typeof effort !== 'string' || effort.length === 0) return { ok: false, available: [] }
  const ids = (Array.isArray(declaredEfforts) ? declaredEfforts : []).map(function (e) {
    return e && typeof e === 'object' ? e.id : e
  }).filter(function (x) { return typeof x === 'string' && x.length > 0 })
  if (ids.length === 0) return { ok: true, available: [] }
  return { ok: ids.indexOf(effort) !== -1, available: ids }
}

/**
 * Fit one requested reasoning effort onto what a model actually declares, so
 * a request never fails with UNSUPPORTED_REASONING_EFFORT.
 *
 * DSH's `llm` service rejects any `reasoningEffort` for a model whose metadata
 * carries no `reasoning` block at all (many OpenRouter routes), and rejects an
 * undeclared id for a model that does declare efforts (deepseek-v4-flash has
 * no `medium`). The router therefore drops the effort in the first case and
 * substitutes the nearest declared one in the second. `off` is treated as the
 * absence of reasoning, not as the ladder's floor: a positive request never
 * resolves to `off` while the model declares a positive level.
 * @param requested - the effort the tier wanted (may be undefined).
 * @param reasoning - `resolveModelInfo().reasoning` ({ efforts, defaultEffort })
 *   or undefined when the model declares no reasoning support.
 * @returns { effort, reason }: the effort to send (undefined = omit) and a
 *   short diagnostic when the value changed, else null.
 */
export function reconcileReasoningEffort(requested, reasoning) {
  // An omitted effort is not a request to disable reasoning. dsh-llm reads a
  // missing `reasoningEffort` as "use the model default"
  // (`requested ?? reasoning.defaultEffort`) and then leaves the choice to the
  // adapter, while `off` is an explicit disable that some routes reject
  // outright (minimax m3.1 flash free: 400 "Reasoning is mandatory for this
  // endpoint and cannot be disabled"). A stage configured without an effort
  // therefore keeps `undefined` here instead of being fitted onto the floor.
  if (requested === undefined || requested === null || requested === '') {
    return { effort: undefined, reason: null }
  }
  if (!reasoning || typeof reasoning !== 'object') {
    return { effort: undefined, reason: 'model declares no reasoning support; effort "' + requested + '" omitted' }
  }
  const ids = (Array.isArray(reasoning.efforts) ? reasoning.efforts : []).map(function (e) {
    return e && typeof e === 'object' ? e.id : e
  }).filter(function (x) { return typeof x === 'string' && x.length > 0 })
  if (ids.length === 0) return { effort: requested, reason: null }
  if (typeof requested === 'string' && ids.indexOf(requested) !== -1) return { effort: requested, reason: null }
  const describe = function (id) {
    return 'effort "' + String(requested) + '" is not declared (available: ' + ids.join(', ') + '); using "' + id + '"'
  }
  // `off` means "no reasoning", not the floor of the ladder. A positive
  // request must never be turned into it: some routes (minimax m3.1 flash
  // free declares off|high|max) reject a disabled reasoning with
  // 400 "Reasoning is mandatory for this endpoint and cannot be disabled",
  // so a cheap tier asking for "low" would fail every step instead of running
  // at the model's lowest positive level.
  const positive = typeof requested === 'string' && requested !== 'off'
  if (positive) {
    const positiveIds = ids.filter(function (id) { return id !== 'off' })
    // Only `off` is declared: there is no positive level to substitute.
    if (positiveIds.length === 0) return { effort: 'off', reason: describe('off') }
    // The adapter's own default is the most faithful answer about its model,
    // but only when it is a positive level (an `off` default is no reasoning).
    if (typeof reasoning.defaultEffort === 'string'
      && reasoning.defaultEffort !== 'off'
      && positiveIds.indexOf(reasoning.defaultEffort) !== -1) {
      return { effort: reasoning.defaultEffort, reason: describe(reasoning.defaultEffort) }
    }
    // Otherwise substitute the *nearest* declared level: the highest one that
    // is not above the request, so an undeclared "max" becomes the model's
    // ceiling ("high") instead of falling to its floor. Never invent a level
    // above the request while one at or below it is declared; when the request
    // is below every declared positive level, the lowest positive level is an
    // upgrade — but honest, and never a silent `off`.
    const at = EFFORT_LADDER.indexOf(requested)
    if (at !== -1) {
      for (let i = at; i >= 0; i--) {
        if (positiveIds.indexOf(EFFORT_LADDER[i]) !== -1) return { effort: EFFORT_LADDER[i], reason: describe(EFFORT_LADDER[i]) }
      }
    }
    let lowestPositive = null
    for (const id of EFFORT_LADDER) if (positiveIds.indexOf(id) !== -1) { lowestPositive = id; break }
    const upgraded = lowestPositive || positiveIds[0]
    return { effort: upgraded, reason: describe(upgraded) }
  }
  // requested === 'off' (or a non-string value): `off` may itself be a
  // declared level here, so keep the original ladder behavior. An *omitted*
  // request never reaches this branch: it is not a disable request.
  // The adapter's own default is the most faithful answer about its model.
  if (typeof reasoning.defaultEffort === 'string' && ids.indexOf(reasoning.defaultEffort) !== -1) {
    return { effort: reasoning.defaultEffort, reason: describe(reasoning.defaultEffort) }
  }
  // `off` (no reasoning) sits below the ladder; scan the full order so a
  // request just above it can still land on it.
  const order = ['off'].concat(EFFORT_LADDER)
  const at = order.indexOf(requested)
  if (at !== -1) {
    for (let i = at; i >= 0; i--) {
      if (ids.indexOf(order[i]) !== -1) return { effort: order[i], reason: describe(order[i]) }
    }
  }
  let lowest = null
  for (const id of order) if (ids.indexOf(id) !== -1) { lowest = id; break }
  const pick = lowest || ids[0]
  return { effort: pick, reason: describe(pick) }
}

/**
 * The effort ladder of the weakest tier: the baseline is low (every current
 * provider declares it, unlike medium); task intensity can raise it through
 * medium and high up to max. Steps never go below low; `off` is not a ladder
 * rung, but `nextEffortStep` treats it as the floor (see below).
 */
export const EFFORT_LADDER = ['low', 'medium', 'high', 'max']

/**
 * The next effort step above current, restricted to the model's declared
 * ids when they are known (lenient: unknown declarations allow the ladder).
 * `off` (no reasoning) sits below the ladder, so a tier configured with it can
 * still be raised to the first declared level.
 * @returns the next effort id, or null when no higher declared level exists.
 */
export function nextEffortStep(current, declaredIds) {
  if (typeof current !== 'string') return null
  const idx = current === 'off' ? -1 : EFFORT_LADDER.indexOf(current)
  if (idx === -1 && current !== 'off') return null
  if (idx >= EFFORT_LADDER.length - 1) return null
  const allowed = Array.isArray(declaredIds) && declaredIds.length > 0 ? declaredIds : EFFORT_LADDER
  for (let i = idx + 1; i < EFFORT_LADDER.length; i++) {
    if (allowed.indexOf(EFFORT_LADDER[i]) !== -1) return EFFORT_LADDER[i]
  }
  return null
}

/**
 * Whether a per-agent fallback record is currently on a chain entry.
 * index is the position in the chain (a fresh record uses -1 = main model);
 * until is the TTL expiry for staying on the fallback model.
 */
export function fallbackActive(rec, now) {
  return !!rec
    && typeof rec.index === 'number' && rec.index >= 0
    && typeof rec.until === 'number' && rec.until > now
}

/**
 * Advance a fallback record one step down the chain.
 * @returns the new record ({ index, until }), or null when the chain is
 *   exhausted (the last entry already failed - the caller clears state and
 *   lets the original error surface).
 */
export function advanceFallback(rec, chain, now, ttlMs) {
  const entries = Array.isArray(chain) ? chain : []
  const index = rec && typeof rec.index === 'number' ? rec.index : -1
  const next = index + 1
  if (next >= entries.length) return null
  return { index: next, until: now + (typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : 300000) }
}

/**
 * Ordered attempt list for one standalone call (consultations): the primary
 * route first, then the tier's fallback chain, without repeating an identical
 * route (the default strong chain repeats its primary).
 * @returns array of { provider, model, reasoningEffort } targets (may be empty).
 */
export function attemptChain(primary, chain) {
  const out = []
  for (const t of [primary].concat(Array.isArray(chain) ? chain : [])) {
    if (!t) continue
    if (out.some(function (o) { return o.provider === t.provider && o.model === t.model && o.reasoningEffort === t.reasoningEffort })) continue
    out.push(t)
  }
  return out
}

/** Coerce one raw fallback entry into { provider, model, reasoningEffort }. */
export function normalizeFallbackEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.provider !== 'string' || entry.provider.length === 0) return null
  if (typeof entry.model !== 'string' || entry.model.length === 0) return null
  return {
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: typeof entry.reasoningEffort === 'string' && entry.reasoningEffort.length > 0 ? entry.reasoningEffort : 'low',
  }
}

/**
 * Default tier shapes. Every tier is driven by this configuration alone: the
 * DSH session model picker is never consulted (v0.10.1). The strong tier
 * ships a self-fallback entry so a first provider refusal retries the route
 * once instead of abandoning the tier; main starts at high and cheap at low
 * on deepseek-v4-flash.
 */
export const DEFAULT_TIER_CONFIG = {
  strong: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    fallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }],
    label: 'strong',
  },
  main: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
    fallback: [],
    label: 'main',
  },
  cheap: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'low',
    fallback: [],
    label: 'cheap',
  },
}

/**
 * Normalize a raw tier config (from settings or defaults) into the full
 * shape. Legacy configs missing fallback are migrated
 * silently: fallback mirrors the
 * configured primary (old installs keep routing exactly where they did).
 */
export function migrateTierConfig(tierName, raw) {
  const defaults = DEFAULT_TIER_CONFIG[tierName] || DEFAULT_TIER_CONFIG.cheap
  if (!raw || typeof raw !== 'object') {
    return { ...defaults, fallback: defaults.fallback.map(function (e) { return { ...e } }) }
  }
  const primary = {
    provider: typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : defaults.provider,
    model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : defaults.model,
    reasoningEffort: typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.length > 0 ? raw.reasoningEffort : defaults.reasoningEffort,
  }
  let fallback
  if (Array.isArray(raw.fallback)) {
    fallback = raw.fallback.map(normalizeFallbackEntry).filter(Boolean)
  } else {
    // Legacy configs predate fallback and must retain their primary-only behavior.
    fallback = [{ ...primary }]
  }
  return {

    provider: primary.provider,
    model: primary.model,
    reasoningEffort: primary.reasoningEffort,
    fallback: fallback,
    label: tierName,
  }
}
