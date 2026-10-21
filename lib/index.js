// dsh-tier-router — Tiered model routing for DeepSeek Harness.
//
// v0.6.0: adapted to DSH 0.2.x plugin/preset model. The durable configuration
// lives on the host-row entry as volatile fields (WebUI-editable, persisted
// to the profile patch); the `tiered` agent preset is declared in
// cordis.patch.yml and mounts this same package with `plane: 'agent'`.
//
// Architecture: all harness contact lives in lib/dsh/* adapters behind a
// capability probe; all decisions live in lib/core/* pure modules. Routing
// rides the `agent/request` waterfall when available (per-request switch,
// loop logs the header itself) and falls back to request/header writes on
// older hosts.

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { isHighImpact } from './core/guard.js'
import {
  resolveTierSpec, classifyFallback, validateReasoningEffort,
  migrateTierConfig, advanceFallback, fallbackActive, nextEffortStep,
  reconcileReasoningEffort, EFFORT_LADDER, attemptChain, childRouteSource, cappedTier,
} from './core/routing.js'
import { activeTierOrder, createTierRegistry, tierLabel, chainText } from './core/tiers.js'
import { escalationActive, escalationExpired, decideGuardAction, decideErrorActions, decidePlanExit, EXPLORE_TOOLS } from './core/policy.js'
import { consultSpec, modelFamily, reviewerConflicts } from './core/consult.js'
import { createDiag } from './core/metrics.js'
import { probeServices, seamReport } from './dsh/services.js'
import { mountRequestWaterfall, headerConfigOf, applyHeaderRoute } from './dsh/routing-seam.js'
import { startWorker } from './dsh/subagents.js'
import { startBackgroundJob } from './dsh/jobs.js'
import { createConfigBridge, vol, HOST_SETTINGS_NS } from './dsh/config.js'
import { createModelCapabilities } from './dsh/model-capabilities.js'

export const name = 'tier-routing'

// Subagent route policies. 'caller' and 'capped' follow the parent; 'capped'
// never goes above the cap tier (main in three tiers, cheap in two).
const SUBAGENT_POLICIES = ['inherit', 'strong', 'cheap', 'main', 'caller', 'capped']

const fallbackEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

// Host-row volatile fields = the durable, WebUI-editable tier configuration.
// The agent-plane row reuses this schema but only reads `plane`.
export const Config = z.object({
  plane: z.union(['host', 'agent']).default('host'),
  mode: z.union(['auto', 'strong', 'cheap', 'delegated', 'off']).default('auto').volatile(),
  strongProvider: z.string().default('deepseek-official').volatile(),
  strongModel: z.string().default('deepseek-v4-pro').volatile(),
  strongEffort: z.string().default('max').volatile(),
  strongFollowSession: z.boolean().default(true).volatile(),
  strongFallback: z.array(fallbackEntrySchema).default([]).volatile(),
  cheapProvider: z.string().default('deepseek-official').volatile(),
  cheapModel: z.string().default('deepseek-v4-flash').volatile(),
  cheapEffort: z.string().default('low').volatile(),
  cheapFollowSession: z.boolean().default(false).volatile(),
  cheapFallback: z.array(fallbackEntrySchema).default([]).volatile(),
  threeTiers: z.boolean().default(false).volatile(),
  mainProvider: z.string().default('deepseek-official').volatile(),
  mainModel: z.string().default('deepseek-v4-pro').volatile(),
  mainEffort: z.string().default('high').volatile(),
  mainFollowSession: z.boolean().default(true).volatile(),
  mainFallback: z.array(fallbackEntrySchema).default([]).volatile(),
  rolesEnabled: z.boolean().default(false).volatile(),
  advisorProvider: z.string().default('').volatile(),
  advisorModel: z.string().default('').volatile(),
  advisorEffort: z.string().default('').volatile(),
  reviewerProvider: z.string().default('').volatile(),
  reviewerModel: z.string().default('').volatile(),
  reviewerEffort: z.string().default('').volatile(),
  subagentPolicy: z.union(SUBAGENT_POLICIES).default('inherit').volatile(),
  spawnPolicy: z.string().default('').volatile(),
  forkPolicy: z.string().default('').volatile(),
  planMinExplore: z.number().default(2).volatile(),
  planAdvisorGate: z.boolean().default(true).volatile(),
})

const ROLE_KINDS = ['advisor', 'reviewer']
const TIER_SLOTS = ['strong', 'main', 'cheap']
// Consultation kind -> the role that routes it.
const CONSULT_ROLE = { advisor: 'advisor', review: 'reviewer' }

const MODES = ['auto', 'strong', 'cheap', 'delegated', 'off']

function log(ctx, level, message) {
  const logger = ctx && ctx.logger
  if (logger && typeof logger[level] === 'function') logger[level](message)
  else if (level === 'warn' || level === 'error') console.error(message)
  else console.log(message)
}

export function apply(ctx, config = {}) {
  const plane = vol(config.plane) || 'host'
  if (plane !== 'agent') {
    // Host row: exists to carry the volatile configuration (auto-generated
    // WebUI settings page + profile persistence). Nothing else to mount.
    log(ctx, 'info', 'tier: host row active — tier configuration is editable in Settings')
    return
  }
  applyAgentPlane(ctx)
}

function applyAgentPlane(ctx) {
  const { services, seams } = probeServices(ctx)
  const { llm, commands, tools, planMode, agentDefaultModel, systemPrompt, subagents, agents, settings, jobs } = services
  if (!seams.llmStream || !seams.llmProviders) {
    log(ctx, 'error', 'tier: llm service seam incomplete (stream=' + seams.llmStream + ' providers=' + seams.llmProviders + '); plugin disabled')
    return
  }
  if (seams.jobsController) {
    // jobs.start refuses an owner no controller serves; attaching one from the
    // preset scope guarantees background tier_worker works.
    try { jobs.attachController('tier-worker') } catch (e) {
      log(ctx, 'warn', 'tier: jobs controller attach failed (background tier_worker may be refused): ' + String(e && e.message || e))
    }
  }

  const diag = createDiag()
  // Cached per-route model metadata: which reasoning efforts a model declares.
  const capabilities = createModelCapabilities(llm, 300000)
  const state = {
    mode: 'auto',
    subagentPolicy: 'inherit',
    spawnPolicy: '',
    forkPolicy: '',
    planMinExplore: 2,
    planAdvisorGate: true,
    escalateThreshold: 2,
    escalateWindowMs: 60000,
    escalateTtlMs: 180000,
    fallbackTtlMs: 300000,
    effortTtlMs: 300000,
    threeTiers: false,
    rolesEnabled: false,
    roles: { advisor: null, reviewer: null },
    tiers: createTierRegistry(null),
  }

  const childTiers = new WeakMap()
  const sessionModes = new WeakMap()
  const sessionBaselines = new WeakMap()
  const escalations = new WeakMap()
  const fallbackStates = new WeakMap()
  const cheapEfforts = new WeakMap()
  // Folded plan/mode state per session. The real Session class exposes no
  // public events array (session.events does not exist on DSH 0.2), so we
  // fold the stream ourselves from the session/event listener below.
  const planStates = new WeakMap()
  // Per subagent child: whether the caller chose its route (decided once).
  const childExplicit = new WeakMap()
  // Per session: the plan-exit gate state of the plan mode in progress.
  const planGates = new WeakMap()

  // ---- durable configuration (host-row volatile fields via settings) -------
  const bridge = createConfigBridge(settings, HOST_SETTINGS_NS, 2000)

  function applyPersisted(rawValue) {
    if (!rawValue || typeof rawValue !== 'object') return false
    // settings.describe() may return the parsed host-row config, whose
    // volatile fields arrive as Volatile refs — unwrap every field.
    const value = {}
    for (const k of ['mode', 'strongProvider', 'strongModel', 'strongEffort', 'strongFollowSession', 'strongFallback', 'cheapProvider', 'cheapModel', 'cheapEffort', 'cheapFollowSession', 'cheapFallback', 'threeTiers', 'mainProvider', 'mainModel', 'mainEffort', 'mainFollowSession', 'mainFallback', 'rolesEnabled', 'advisorProvider', 'advisorModel', 'advisorEffort', 'reviewerProvider', 'reviewerModel', 'reviewerEffort', 'subagentPolicy', 'spawnPolicy', 'forkPolicy', 'planMinExplore', 'planAdvisorGate']) {
      value[k] = vol(rawValue[k])
    }
    if (MODES.indexOf(value.mode) !== -1) state.mode = value.mode
    state.threeTiers = value.threeTiers === true
    state.rolesEnabled = value.rolesEnabled === true
    state.tiers.set('strong', migrateTierConfig('strong', {
      followSession: value.strongFollowSession,
      provider: value.strongProvider,
      model: value.strongModel,
      reasoningEffort: value.strongEffort,
      fallback: value.strongFallback,
    }))
    state.tiers.set('main', migrateTierConfig('main', {
      followSession: value.mainFollowSession,
      provider: value.mainProvider,
      model: value.mainModel,
      reasoningEffort: value.mainEffort,
      fallback: value.mainFallback,
    }))
    state.tiers.set('cheap', migrateTierConfig('cheap', {
      followSession: value.cheapFollowSession,
      provider: value.cheapProvider,
      model: value.cheapModel,
      reasoningEffort: value.cheapEffort,
      fallback: value.cheapFallback,
    }))
    state.roles = { advisor: roleFrom(value, 'advisor'), reviewer: roleFrom(value, 'reviewer') }
    if (SUBAGENT_POLICIES.indexOf(value.subagentPolicy) !== -1) state.subagentPolicy = value.subagentPolicy
    state.spawnPolicy = kindPolicyOrEmpty('spawn', value.spawnPolicy)
    state.forkPolicy = kindPolicyOrEmpty('fork', value.forkPolicy)
    if (typeof value.planMinExplore === 'number' && value.planMinExplore >= 0) state.planMinExplore = Math.floor(value.planMinExplore)
    state.planAdvisorGate = value.planAdvisorGate === true || (value.planAdvisorGate === undefined && state.planAdvisorGate)
    return true
  }

  /** A configured consultation role, or null while its provider or model is unset. */
  function roleFrom(value, kind) {
    const provider = value[kind + 'Provider']
    const model = value[kind + 'Model']
    if (!provider || !model) return null
    return { provider: provider, model: model, reasoningEffort: value[kind + 'Effort'] || undefined }
  }

  applyPersisted(bridge.read())
  if (typeof ctx.on === 'function' && bridge.readable) {
    try {
      ctx.on('settings/document-updated', (ns) => {
        if (ns !== HOST_SETTINGS_NS) return
        bridge.invalidate()
        try { applyPersisted(bridge.read()) } catch (e) {
          log(ctx, 'warn', 'tier: settings reload failed: ' + String(e && e.message || e))
        }
      })
    } catch (e) {}
  }

  async function persistTierConfig() {
    if (!bridge.writable) return ' (settings service unavailable — change is session-only)'
    try {
      const strong = state.tiers.get('strong')
      const main = state.tiers.get('main')
      const cheap = state.tiers.get('cheap')
      const advisor = state.roles.advisor || { provider: '', model: '', reasoningEffort: '' }
      const reviewer = state.roles.reviewer || { provider: '', model: '', reasoningEffort: '' }
      await bridge.write({
        mode: state.mode,
        strongProvider: strong.provider,
        strongModel: strong.model,
        strongEffort: strong.reasoningEffort,
        strongFollowSession: strong.followSession,
        strongFallback: strong.fallback,
        threeTiers: state.threeTiers,
        mainProvider: main.provider,
        mainModel: main.model,
        mainEffort: main.reasoningEffort,
        mainFollowSession: main.followSession,
        mainFallback: main.fallback,
        cheapProvider: cheap.provider,
        cheapModel: cheap.model,
        cheapEffort: cheap.reasoningEffort,
        cheapFollowSession: cheap.followSession,
        cheapFallback: cheap.fallback,
        rolesEnabled: state.rolesEnabled,
        advisorProvider: advisor.provider,
        advisorModel: advisor.model,
        advisorEffort: advisor.reasoningEffort || '',
        reviewerProvider: reviewer.provider,
        reviewerModel: reviewer.model,
        reviewerEffort: reviewer.reasoningEffort || '',
        subagentPolicy: state.subagentPolicy,
        spawnPolicy: state.spawnPolicy,
        forkPolicy: state.forkPolicy,
        planMinExplore: state.planMinExplore,
        planAdvisorGate: state.planAdvisorGate,
      })
      bridge.invalidate()
      return ' Saved to the tier-routing profile entry (survives restarts).'
    } catch (e) {
      return ' (settings persist failed: ' + String(e && e.message || e) + ')'
    }
  }

  // ---- registration isolation ---------------------------------------------
  function safeRegister(label, fn) {
    try {
      fn()
      return true
    } catch (e) {
      log(ctx, 'error', 'tier: ' + label + ' registration failed (continuing without it): ' + String(e && e.message || e))
      return false
    }
  }

  let providerCache = null
  let providerCacheAt = 0
  function availableProviders() {
    const now = Date.now()
    if (providerCache && now - providerCacheAt < 10000) return providerCache
    try {
      providerCache = (llm.listProviders() || []).map(function (p) { return p.id })
      providerCacheAt = now
    } catch (e) {
      log(ctx, 'warn', 'tier: listProviders failed: ' + String(e && e.message || e))
      providerCache = providerCache || []
    }
    return providerCache
  }

  function agentIdentity(agent) {
    let id = '?'
    let origin = '?'
    try { id = String(agent && agent.id) } catch (e) { id = 'unreadable' }
    try { origin = String(agent && agent.session && agent.session.header && agent.session.header.origin || '') || '(main)' } catch (e) { origin = 'unreadable' }
    return id + '[' + origin + ']'
  }

  function isChildAgent(agent) {
    if (!agent) return false
    if (childTiers.has(agent)) return true
    try { return !!(agent.session && agent.session.header && agent.session.header.origin === 'subagent') } catch (e) { return false }
  }

  function effectiveMode(agent) {
    if (agent && sessionModes.has(agent)) return sessionModes.get(agent)
    return state.mode
  }

  function delegatedMain(agent) {
    return !!agent && !isChildAgent(agent) && effectiveMode(agent) === 'delegated'
  }

  function planActive(agent) {
    // Fold the plan/mode stream the same way dsh-plan-mode does ("last event
    // wins"), instead of reading the planMode service: the service lives
    // inside the preset's plan-mode isolate realm, which is not reachable
    // from this standing-scope row. The fold lives in planStates (populated
    // by the session/event listener); a visible session.events array, when
    // one exists (older hosts / mocks), is folded as a fallback.
    try {
      const session = agent && agent.session
      if (!session) return false
      if (planStates.has(session)) return planStates.get(session)
      const events = session.events
      if (!events) return false
      let active = false
      for (const e of events) {
        if (e && e.type === 'plan/mode') active = !!(e.data && e.data.active)
      }
      return active
    } catch (e) { return false }
  }

  function setPlanMode(agent, active) {
    if (planMode && agent) {
      try {
        const outcome = planMode.set(agent, active)
        if (outcome) {
          if (agent.session && typeof agent.session === 'object') planStates.set(agent.session, active)
          return outcome
        }
      } catch (e) {}
    }
    if (agent && agent.session && typeof agent.session.append === 'function') {
      try {
        agent.session.append('plan/mode', { active })
        planStates.set(agent.session, active)
        return 'committed'
      } catch (e) {}
    }
    return 'unavailable'
  }

  function isEscalated(agent) {
    if (!agent || !escalations.has(agent)) return false
    const rec = escalations.get(agent)
    if (escalationActive(rec, Date.now())) return true
    // Counting records (until === 0) must survive between errors or
    // consecutive failures never reach the threshold; expired ones are GC'd.
    if (escalationExpired(rec, Date.now())) escalations.delete(agent)
    return false
  }

  function tierNameFor(agent, planActiveOverride) {
    return resolveTierSpec({
      explicitTier: agent && childTiers.has(agent) ? childTiers.get(agent) : undefined,
      sessionMode: agent ? sessionModes.get(agent) : undefined,
      escalated: isEscalated(agent),
      isChild: isChildAgent(agent),
      subagentPolicy: policyFor(agent),
      mode: state.mode,
      planActive: planActiveOverride === undefined ? planActive(agent) : planActiveOverride,
      tiers: activeTierOrder(state.threeTiers),
    })
  }

  /** The tier plan mode runs on: main in the three-tier layout, strong otherwise. */
  function planTierName() {
    return state.threeTiers ? 'main' : 'strong'
  }

  function defaultSelectionTarget() {
    try {
      if (agentDefaultModel) {
        const sel = agentDefaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string') {
          return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || 'high' }
        }
      }
    } catch (e) {}
    return null
  }

  function captureBaseline(agent, seedConfig) {
    if (!agent || sessionBaselines.has(agent)) return sessionBaselines.get(agent) || null
    let baseline = null
    if (seedConfig && typeof seedConfig.provider === 'string' && typeof seedConfig.model === 'string') {
      baseline = { provider: seedConfig.provider, model: seedConfig.model, reasoningEffort: seedConfig.reasoningEffort || 'high' }
    }
    if (!baseline) {
      try {
        const current = headerConfigOf(agent.session)
        if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
          baseline = { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort || 'high' }
        }
      } catch (e) {}
    }
    if (!baseline) {
      try {
        const options = agent.options
        if (options && typeof options.provider === 'string' && typeof options.model === 'string') {
          baseline = { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort || 'high' }
        }
      } catch (e) {}
    }
    if (!baseline) baseline = defaultSelectionTarget()
    if (baseline) sessionBaselines.set(agent, baseline)
    return baseline
  }

  function tierOf(tierName) { return state.tiers.get(tierName) || state.tiers.get('cheap') }

  /** Strong and main follow the session model; the cheap tier never does. */
  function followsSession(tierName) {
    return tierName !== 'cheap' && !!tierOf(tierName).followSession
  }

  /**
   * The ordered fallback chain of one tier. When the tier follows the session
   * model, its explicit provider/model/effort is the first step after the
   * session model (the fallback base), then the configured chain; duplicates
   * are dropped.
   */
  function chainFor(tierName) {
    const tier = tierOf(tierName)
    const base = followsSession(tierName) ? [{ provider: tier.provider, model: tier.model, reasoningEffort: tier.reasoningEffort }] : []
    return attemptChain(null, base.concat(Array.isArray(tier.fallback) ? tier.fallback : []))
  }

  function activeFallbackTarget(agent, tierName) {
    if (!agent || !fallbackStates.has(agent)) return null
    const rec = fallbackStates.get(agent)
    const now = Date.now()
    if (rec.tierName !== tierName || rec.index < 0 || rec.until <= now) {
      fallbackStates.delete(agent)
      return null
    }
    const chain = chainFor(tierName)
    if (rec.index >= chain.length) {
      fallbackStates.delete(agent)
      return null
    }
    return chain[rec.index]
  }

  function triggerFallback(agent, tierName, failureText) {
    const chain = chainFor(tierName)
    if (!Array.isArray(chain) || chain.length === 0) return { exhausted: true }
    let rec = fallbackStates.get(agent)
    const now = Date.now()
    if (!rec || rec.tierName !== tierName || rec.index < 0 || rec.until <= now) rec = { index: -1, until: 0 }
    const next = advanceFallback(rec, chain, now, state.fallbackTtlMs)
    if (!next) {
      fallbackStates.delete(agent)
      diag.lastFallback = '#' + (diag.fallbacks + 1) + ' chain exhausted for ' + agentIdentity(agent) + ' (' + tierName + '): ' + failureText
      return { exhausted: true }
    }
    fallbackStates.set(agent, { ...next, tierName: tierName })
    diag.fallbacks = diag.fallbacks + 1
    const target = chain[next.index]
    diag.lastFallback = '#' + diag.fallbacks + ' fallback ' + tierName + ' -> ' + target.provider + '/' + target.model + ' (TTL ' + Math.round(state.fallbackTtlMs / 1000) + 's, index ' + next.index + ') for ' + agentIdentity(agent) + ': ' + failureText
    return { target: target, index: next.index }
  }

  function clearRoutingTransients(agent) {
    if (!agent) return
    fallbackStates.delete(agent)
    cheapEfforts.delete(agent)
  }

  function cheapEffortState(agent) {
    if (!agent || !cheapEfforts.has(agent)) return null
    const rec = cheapEfforts.get(agent)
    if (rec.until !== 0 && rec.until <= Date.now()) {
      cheapEfforts.delete(agent)
      return null
    }
    return rec
  }

  function currentCheapEffort(agent) {
    const rec = cheapEffortState(agent)
    return rec ? rec.effort : state.tiers.get('cheap').reasoningEffort
  }

  async function declaredEfforts(provider, model) {
    const info = await capabilities.reasoningOf(provider, model)
    if (!info.known) return null
    const reasoning = info.reasoning
    if (!reasoning || !Array.isArray(reasoning.efforts)) return null
    return reasoning.efforts.map(function (e) { return e && e.id }).filter(function (x) { return typeof x === 'string' })
  }

  async function validateEffortFor(provider, model, effort) {
    const declared = await declaredEfforts(provider, model)
    if (declared === null) return { ok: true, available: [] }
    return validateReasoningEffort(effort, declared)
  }

  async function raiseCheapEffort(agent, reason) {
    if (!agent) return { raised: false, effort: null, message: 'no agent' }
    const cheap = state.tiers.get('cheap')
    const current = currentCheapEffort(agent)
    const declared = await declaredEfforts(cheap.provider, cheap.model)
    const next = nextEffortStep(current, declared)
    if (!next) {
      const ceiling = declared && declared.length ? ' model ' + cheap.provider + '/' + cheap.model + ' declares only: ' + declared.join(', ') : ' already at max'
      diag.lastEffort = 'effort raise blocked: cheap effort stays ' + current + ' for ' + agentIdentity(agent) + ' (' + reason + ');' + ceiling
      return { raised: false, effort: current, message: 'Cheap tier effort stays ' + current + ';' + ceiling + '.' }
    }
    cheapEfforts.set(agent, { effort: next, until: Date.now() + state.effortTtlMs })
    diag.effortRaises = diag.effortRaises + 1
    diag.lastEffort = '#' + diag.effortRaises + ' cheap effort ' + current + ' -> ' + next + ' (' + reason + ') for ' + agentIdentity(agent)
    return { raised: true, effort: next, message: 'Cheap tier effort raised to ' + next + ' for this session (TTL ' + Math.round(state.effortTtlMs / 1000) + 's).' }
  }

  /** The strong route as a standalone target: the session selection when followed, else the explicit pair. */
  function strongPrimary() {
    const strong = state.tiers.get('strong')
    return (strong.followSession && defaultSelectionTarget())
      || { provider: strong.provider, model: strong.model, reasoningEffort: strong.reasoningEffort }
  }

  /** The configured advisor/reviewer route, or null when roles are off or unset. */
  function roleTarget(kind) {
    return state.rolesEnabled && state.roles[kind] ? state.roles[kind] : null
  }

  /**
   * Attempt order for one consultation: the role route (when configured),
   * then the strong route and its fallback chain. Roles never have a chain of
   * their own.
   */
  function consultAttempts(kind) {
    return attemptChain(roleTarget(kind), [strongPrimary()].concat(chainFor('strong')))
  }

  function consultRouteText(kind) {
    const role = roleTarget(kind)
    if (role) return 'configured role ' + role.provider + '/' + role.model
    const strong = state.tiers.get('strong')
    return strong.followSession ? 'follows your session model selection' : 'configured as ' + tierLabel(strong)
  }

  function effectiveTarget(agent, tierName) {
    const tier = tierOf(tierName)
    const fallback = activeFallbackTarget(agent, tierName)
    if (fallback) return { tierName: tierName, provider: fallback.provider, model: fallback.model, reasoningEffort: fallback.reasoningEffort }
    if (tierName !== 'cheap') {
      if (followsSession(tierName)) {
        const sel = defaultSelectionTarget()
        if (sel) return { tierName: tierName, provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || 'high' }
      }
      return { tierName: tierName, provider: tier.provider, model: tier.model, reasoningEffort: tier.reasoningEffort }
    }
    return { tierName: tierName, provider: tier.provider, model: tier.model, reasoningEffort: currentCheapEffort(agent) }
  }

  /**
   * Fit one target's reasoning effort onto the model's declared efforts.
   * `llm` rejects an undeclared effort (deepseek-v4-flash has no `medium`) and
   * rejects any effort for a model with no reasoning metadata (many OpenRouter
   * routes), so the router omits or substitutes instead of letting the request
   * fail with UNSUPPORTED_REASONING_EFFORT.
   * @param target - { provider, model, reasoningEffort } (unchanged on failure).
   * @returns the fitted target (same object when nothing changed).
   */
  async function reconcileTarget(target) {
    if (!target || !capabilities.usable) return target
    const info = await capabilities.reasoningOf(target.provider, target.model)
    if (!info.known) return target
    const fitted = reconcileReasoningEffort(target.reasoningEffort, info.reasoning)
    if (fitted.effort === target.reasoningEffort) return target
    diag.lastEffort = 'effort fitted for ' + target.provider + '/' + target.model + ': ' + fitted.reason
    const next = { ...target }
    if (fitted.effort === undefined) delete next.reasoningEffort
    else next.reasoningEffort = fitted.effort
    return next
  }

  /** Cache-only variant for synchronous paths (no metadata fetch). */
  function reconcileTargetCached(target) {
    if (!target) return target
    const hit = capabilities.peek(target.provider, target.model)
    if (!hit || !hit.known) return target
    const fitted = reconcileReasoningEffort(target.reasoningEffort, hit.reasoning)
    if (fitted.effort === target.reasoningEffort) return target
    const next = { ...target }
    if (fitted.effort === undefined) delete next.reasoningEffort
    else next.reasoningEffort = fitted.effort
    return next
  }

  /**
   * The single routing decision used by every seam: which call config this
   * agent's next request should carry. Returns a target or null (seed/baseline
   * preserved). Async because the effort is fitted to the model's declared
   * capabilities before the request leaves.
   */
  /** The parent agent of a subagent child, found through its session lineage. */
  function parentAgentOf(agent) {
    try {
      const parentId = agent.session && agent.session.header && agent.session.header.parentSession
      return parentId && seams.agentsGet ? agents.get(parentId) || null : null
    } catch (e) { return null }
  }

  /**
   * The route a parent agent uses right now: { tierName, target }. The tier
   * is null when the parent is off or hands-off (its baseline is the route).
   */
  function parentRouteOf(agent) {
    const parent = parentAgentOf(agent)
    if (!parent) return null
    const tierName = tierNameFor(parent)
    if (tierName) return { tierName: tierName, target: effectiveTarget(parent, tierName) }
    const baseline = captureBaseline(parent)
    return baseline ? { tierName: null, target: baseline } : null
  }

  /** Fork children carry the parent's history (the session header's isSeeded marks fork lineage). */
  function isForkChild(agent) {
    try { return !!(agent.session && agent.session.header && agent.session.header.isSeeded === true) } catch (e) { return false }
  }

  /** Why a per-kind subagent policy value is refused, or null when it is accepted. */
  function kindPolicyError(kind, policy) {
    if (policy === '' || policy === undefined || policy === null) return null
    if (SUBAGENT_POLICIES.indexOf(policy) === -1) return 'unknown subagent policy "' + policy + '"'
    if (kind === 'spawn' && policy === 'caller') return 'caller applies to fork children only: a spawn child starts with an empty conversation and gains no cache from the parent'
    if (policy === 'main' && !state.threeTiers) return 'main needs the three-tier layout (/tier layout three)'
    return null
  }

  function kindPolicyOrEmpty(kind, policy) {
    return kindPolicyError(kind, policy) ? '' : (policy || '')
  }

  /**
   * The policy that routes one agent. Non-children use the global default.
   * A child uses its kind's policy (spawn or fork), falling back to
   * subagentPolicy; caller is refused for spawn, which then behaves as inherit.
   */
  function policyFor(agent) {
    if (!isChildAgent(agent)) return state.subagentPolicy
    const fork = isForkChild(agent)
    const policy = (fork ? state.forkPolicy : state.spawnPolicy) || state.subagentPolicy
    return !fork && policy === 'caller' ? 'inherit' : policy
  }

  function matchesTierRoute(route) {
    return TIER_SLOTS.some(function (name) {
      const tier = state.tiers.get(name)
      return !!tier && tier.provider === route.provider && tier.model === route.model
    })
  }

  /**
   * Whether the caller chose this child's route. Decided once, on the child's
   * first request: the seed differs from the parent's route and is not one of
   * this plugin's tier routes (tier_worker seeds carry tier routes).
   */
  function childIsExplicit(agent, seed) {
    if (childExplicit.has(agent)) return childExplicit.get(agent)
    const parentRoute = parentRouteOf(agent)
    if (!parentRoute || !seed) return false
    const route = parentRoute.target
    const explicit = (seed.provider !== route.provider || seed.model !== route.model) && !matchesTierRoute(seed)
    childExplicit.set(agent, explicit)
    return explicit
  }

  async function resolveRoute(agent, seedConfig) {
    if (!agent) return null
    captureBaseline(agent, seedConfig)
    const mode = effectiveMode(agent)
    if (mode === 'off' || delegatedMain(agent)) {
      // Routing disabled or main-agent hands-off: restore the session's
      // baseline selection instead of replaying a previously routed header.
      return captureBaseline(agent) || null
    }
    if (isChildAgent(agent)) {
      const policy = policyFor(agent)
      const parentRoute = policy === 'caller' || policy === 'capped' ? parentRouteOf(agent) : null
      const source = childRouteSource({
        pinned: childTiers.has(agent),
        escalated: isEscalated(agent),
        explicit: childIsExplicit(agent, seedConfig),
        policy: policy,
        hasParentRoute: !!parentRoute,
      })
      if (source === 'keep') return null
      if (source === 'parent') return reconcileTarget(parentRoute.target)
      if (source === 'capped') {
        const capTier = state.threeTiers ? 'main' : 'cheap'
        const tierName = cappedTier(parentRoute.tierName, capTier, activeTierOrder(state.threeTiers))
        return reconcileTarget(tierName !== parentRoute.tierName ? effectiveTarget(agent, tierName) : parentRoute.target)
      }
    }
    const tierName = tierNameFor(agent)
    if (!tierName) return null
    return reconcileTarget(effectiveTarget(agent, tierName))
  }

  // The routing seam: waterfall when the runtime has it, header writes
  // otherwise. `applyTarget` below always means "make the NEXT request use
  // this target"; in waterfall mode the seam itself performs it.
  const seamMode = (typeof ctx.on === 'function' && mountRequestWaterfall(ctx, resolveRoute, diag)) ? 'waterfall' : 'header'

  function applyTarget(agent, target) {
    if (!agent || !target) return
    captureBaseline(agent)
    // Waterfall mode writes nothing here: the loop logs request/header itself
    // when the routed config changes. A header appended from a listener between
    // turns is outside an open turn, and DSH refuses to load that session.
    if (seamMode === 'header') applyHeaderRoute(agent, reconcileTargetCached(target), diag)
  }

  // ---- consultation primitive ---------------------------------------------
  let msgSeq = 0
  async function streamText(tier, system, userText, signal) {
    if (availableProviders().indexOf(tier.provider) === -1) {
      const message = 'provider "' + tier.provider + '" is not registered in this process. Registered: ' + availableProviders().join(', ')
      return { text: 'Call failed: ' + message, ok: false, failure: { code: 'NO_ADAPTER', message: message } }
    }
    const route = await reconcileTarget(tier)
    const options = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
      system: system,
      messages: [{
        id: 'tier-msg-' + (++msgSeq) + '-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }],
      signal: signal,
    }
    let text = ''
    let finish = null
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk && chunk.type === 'text-delta') text += chunk.text
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
    } catch (e) {
      finish = { kind: 'error', failure: { message: String(e && e.message || e) } }
    }
    if (!finish) finish = { kind: 'error', failure: { message: 'stream ended without a finish chunk' } }
    if (finish.kind === 'stop' && text.trim().length > 0) return { text: text.trim(), ok: true, truncated: false }
    if (finish.kind === 'max-tokens' && text.trim().length > 0) return { text: text.trim() + '\n[truncated by max-tokens]', ok: true, truncated: true }
    if (finish.kind === 'aborted') return { text: 'Call was aborted.', ok: false, failure: finish.failure }
    return { text: 'Call failed: ' + String(finish.failure && finish.failure.message || finish.kind), ok: false, failure: finish.failure }
  }

  /**
   * One consultation (advisor/review) over the strong tier. Tries the primary
   * route, then the strong fallback chain, moving on only for the failures the
   * main request path falls back on (classifyFallback). Stateless per call: a
   * consult never moves the calling agent's own fallback state.
   * @returns the consult spec's parsed result plus `route`, the target that answered
   *   (or the last one tried).
   */
  async function runConsult(kind, input, signal) {
    const spec = consultSpec(kind)
    const userText = spec.buildUser(input)
    let route = null
    let result = null
    for (const target of consultAttempts(CONSULT_ROLE[kind])) {
      route = target
      result = await streamText(target, spec.system, userText, signal)
      if (result.ok || classifyFallback(result.failure) !== 'fallback') break
      diag.fallbacks = diag.fallbacks + 1
      diag.lastFallback = '#' + diag.fallbacks + ' consult ' + kind + ' ' + target.provider + '/' + target.model + ' failed, trying next route: ' + String(result.text).slice(0, 100)
    }
    return { ...spec.parse(result.text, result.ok), route: route }
  }

  function effectiveExecutionTier(agent) {
    if (effectiveMode(agent) === 'off' || delegatedMain(agent)) {
      try {
        const sel = agentDefaultModel && agentDefaultModel.currentSelection()
        const cheap = state.tiers.get('cheap')
        if (sel && sel.provider === cheap.provider && sel.model === cheap.model) return 'cheap'
      } catch (e) {}
      return 'strong'
    }
    return tierNameFor(agent) || 'strong'
  }

  async function listModelsText() {
    const lines = []
    for (const provider of availableProviders()) {
      try {
        const models = seams.llmModels ? await llm.listModels(provider) : []
        lines.push(provider + ': ' + ((models || []).map(function (m) { return m.id }).join(', ') || '(no catalog)'))
      } catch (e) {
        lines.push(provider + ': (listModels failed: ' + String(e && e.message || e) + ')')
      }
    }
    return lines.join('\n')
  }

  function statusText(agent) {
    let sessionDefault = ''
    if (agentDefaultModel) {
      try {
        const sel = agentDefaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string') sessionDefault = 'session default: ' + sel.provider + '/' + sel.model + ' (' + (sel.reasoningEffort || 'default') + ')'
      } catch (e) {}
    }
    const strong = state.tiers.get('strong')
    const main = state.tiers.get('main')
    const cheap = state.tiers.get('cheap')
    const reviewer = consultAttempts('reviewer')[0]
    const implementers = [{ label: 'cheap tier', provider: cheap.provider, model: cheap.model }]
    if (state.threeTiers) implementers.push({ label: 'main tier', provider: main.provider, model: main.model })
    const sessionModel = defaultSelectionTarget()
    if (sessionModel) implementers.push({ label: 'session model', provider: sessionModel.provider, model: sessionModel.model })
    const conflicts = reviewerConflicts(reviewer, implementers)
    const reviewLine = '  review: ' + reviewer.provider + '/' + reviewer.model + ' (family ' + modelFamily(reviewer.model) + ')' + (conflicts.length
      ? ' WARNING: same family as ' + conflicts.map(function (c) { return c.label + ' ' + c.provider + '/' + c.model }).join(', ') + '; a same-family reviewer shares the implementer\'s blind spots, pick a reviewer from another model family'
      : ' (no implementer shares its family)')
    const driftSteps = consultAttempts('reviewer').slice(1)
      .map(function (t) { return { t: t, conflicts: reviewerConflicts(t, implementers) } })
      .filter(function (x) { return x.conflicts.length > 0 })
    const driftLine = driftSteps.length
      ? '  review chain: WARNING: fallback ' + driftSteps.map(function (x) { return x.t.provider + '/' + x.t.model + ' (family ' + modelFamily(x.t.model) + ', same as ' + x.conflicts[0].label + ')' }).join(', ') + '; if the reviewer fails over to it, the verdict comes from a same-family model'
      : ''
    const roleLine = (kind) => '  ' + kind + ': ' + (roleTarget(kind)
      ? 'role ' + roleTarget(kind).provider + '/' + roleTarget(kind).model + ' (fallback: strong route)'
      : 'strong route (' + consultAttempts(kind)[0].provider + '/' + consultAttempts(kind)[0].model + ')' + (state.roles[kind] ? '; role configured but inactive' : ''))
    return [
      'Tiered model routing',
      '  mode: global=' + state.mode + ', this session=' + (agent ? (sessionModes.has(agent) ? sessionModes.get(agent) : state.mode) : 'n/a') + ' (per-session via /tier strong|main|cheap|auto|delegated|off; escalate: ' + state.escalateThreshold + ' errors / ' + Math.round(state.escalateWindowMs / 1000) + 's window -> ' + Math.round(state.escalateTtlMs / 1000) + 's strong)',
      '  layout: ' + (state.threeTiers ? 'three tiers (strong = escalation, main = plan mode, cheap = execution)' : 'two tiers (strong = plan mode, cheap = execution); /tier layout three enables main'),
      '  strong: ' + tierLabel(strong) + (strong.followSession ? ' (follows session selection)' : '') + '; fallback: ' + chainText({ fallback: chainFor('strong') }),
      '  main:   ' + tierLabel(main) + (main.followSession ? ' (follows session selection)' : '') + '; fallback: ' + chainText({ fallback: chainFor('main') }) + (state.threeTiers ? '' : ' (inactive)'),
      '  cheap:  ' + tierLabel(cheap) + '; fallback: ' + chainText({ fallback: chainFor('cheap') }),
      '  roles: ' + (state.rolesEnabled ? 'on' : 'off (advisor and reviewer use the strong route; /tier roles on enables their own routes)'),
      roleLine('advisor'),
      roleLine('reviewer'),
      reviewLine,
      driftLine,
      '  fallback TTL: ' + Math.round(state.fallbackTtlMs / 1000) + 's; effort TTL: ' + Math.round(state.effortTtlMs / 1000) + 's',
      '  config persisted: ' + (bridge.readable ? 'yes (host entry "' + HOST_SETTINGS_NS + '"' + (bridge.writable ? ', writable' : ', read-only') + ')' : 'no (settings service unavailable, in-memory only)'),
      '  subagents: ' + state.subagentPolicy + ' (spawn: ' + (state.spawnPolicy || 'default') + ', fork: ' + (state.forkPolicy || 'default') + ')',
      '  subagent api: ' + (seams.subagentsActivation ? 'startActivation' : seams.subagentsLegacy ? 'legacy start' : 'unavailable') + '; providers: ' + (seams.subagentsList ? subagents.list().join(', ') : 'n/a') + '; background jobs: ' + (seams.jobsStart ? 'available' : 'unavailable'),
      '  routing seam: ' + seamMode,
      '  seams: ' + seamReport(seams),
      '  diag: requestSteps=' + diag.requestSteps + ' guardChecks=' + diag.guardChecks + ' guardDenies=' + diag.guardDenies + ' headerWrites=' + diag.headerWrites + ' inboxSeen=' + diag.inboxSeen + ' planFlips=' + diag.planFlips + ' errorsSeen=' + diag.errorsSeen + ' escalations=' + diag.escalations + ' fallbacks=' + diag.fallbacks + ' effortRaises=' + diag.effortRaises,
      diag.lastRouting ? '  lastRouting: ' + diag.lastRouting : '',
      diag.lastGuard ? '  lastGuard: ' + diag.lastGuard : '',
      diag.lastGuardError ? '  lastGuardError: ' + diag.lastGuardError : '',
      diag.lastHeader ? '  lastHeader: ' + diag.lastHeader : '',
      diag.lastError ? '  lastError: ' + diag.lastError : '',
      diag.lastEscalation ? '  lastEscalation: ' + diag.lastEscalation : '',
      diag.lastFallback ? '  lastFallback: ' + diag.lastFallback : '',
      diag.lastEffort ? '  lastEffort: ' + diag.lastEffort : '',
      '  plan gate: explore >= ' + state.planMinExplore + ' before exit_plan_mode, advisor review ' + (state.planAdvisorGate ? 'on' : 'off') + '; denies=' + diag.planGateDenies + ' consults=' + diag.planConsults,
      diag.lastGate ? '  lastGate: ' + diag.lastGate : '',
      sessionDefault ? '  ' + sessionDefault : '  session default: unavailable',
      '  providers: ' + availableProviders().join(', '),
    ].join('\n')
  }

  async function applyRoute(tier, persist, agent) {
    if (tier === 'auto') {
      if (agent) sessionModes.set(agent, 'auto')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) applyTarget(agent, effectiveTarget(agent, planActive(agent) ? planTierName() : 'cheap'))
      return { applied: tier, message: 'Routing mode set to auto for THIS session (plan mode -> ' + planTierName() + ' tier, execution -> cheap tier). Other sessions keep their own mode.' }
    }
    if (tier === 'delegated') {
      if (agent) sessionModes.set(agent, 'delegated')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) {
        const selected = captureBaseline(agent) || defaultSelectionTarget()
        if (selected) applyTarget(agent, selected)
      }
      return { applied: tier, message: 'This session keeps its main agent on the session-selected model; only subagents are tier-routed.' }
    }
    if (tier === 'off') {
      if (agent) sessionModes.set(agent, 'off')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) {
        const def = captureBaseline(agent) || defaultSelectionTarget()
        if (def) applyTarget(agent, def)
      }
      return { applied: tier, message: 'Routing disabled for THIS session; its model returns to the default. Other sessions are unaffected; only explicit commands and tools act here.' }
    }
    if (tier === 'main' && !state.threeTiers) return { applied: tier, message: 'The main tier is inactive: the two-tier layout is on. Enable it with /tier layout three.' }
    const target = TIER_SLOTS.indexOf(tier) !== -1 ? state.tiers.get(tier) : null
    if (!target) return { applied: tier, message: 'Unknown tier "' + tier + '". Use strong, main, cheap, auto, delegated, or off.' }
    if (availableProviders().indexOf(target.provider) === -1) {
      return { applied: tier, message: 'Provider "' + target.provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    if (agent) sessionModes.set(agent, tier)
    clearRoutingTransients(agent)
    if (agent && !isChildAgent(agent)) applyTarget(agent, effectiveTarget(agent, tier))
    let persisted = ''
    if (persist && agentDefaultModel && seams.defaultModelSave) {
      try {
        await agentDefaultModel.saveSelection({ provider: target.provider, model: target.model, reasoningEffort: target.reasoningEffort })
        persisted = ' Saved as the session default.'
      } catch (e) {
        persisted = ' Could not persist the session default: ' + String(e && e.message || e)
      }
    }
    return { applied: tier, message: 'This session now routes to the ' + tier + ' tier (' + tierLabel(target) + '). Other sessions keep their own mode.' + persisted }
  }

  /**
   * Configure one consultation role (advisor or reviewer). A role is a
   * provider/model/effort only: it has no session-follow mode and no chain of
   * its own, since its fallback is the strong route.
   */
  async function applyRoleConfigure(args) {
    const kind = args.tier
    if (args.followSession === true) return { ok: false, message: kind + ' is a role, not a tier: it has no follow-session mode.' }
    if (Array.isArray(args.fallback)) return { ok: false, message: 'Roles share the strong fallback chain; configure that chain with tier "strong" instead.' }
    const current = state.roles[kind]
    const provider = args.provider || (current ? current.provider : '')
    const model = args.model || (current ? current.model : '')
    if (!provider || !model) return { ok: false, message: 'Set both provider and model for the ' + kind + ' role.' }
    if (availableProviders().indexOf(provider) === -1) {
      return { ok: false, message: 'Provider "' + provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    const effort = args.reasoningEffort || (current ? current.reasoningEffort : undefined)
    if (args.reasoningEffort) {
      const check = await validateEffortFor(provider, model, args.reasoningEffort)
      if (!check.ok) {
        return { ok: false, message: 'Rejected effort "' + args.reasoningEffort + '" for ' + provider + '/' + model + ': the model declares only ' + check.available.join(', ') + '.' }
      }
    }
    state.roles[kind] = { provider: provider, model: model, reasoningEffort: effort }
    const persisted = args.sessionOnly !== true ? await persistTierConfig() : ''
    const active = state.rolesEnabled ? '' : ' The role is inactive until /tier roles on.'
    return { ok: true, message: 'Configured ' + kind + ' role: ' + provider + '/' + model + (effort ? ' (' + effort + ')' : '') + '.' + active + persisted }
  }

  async function applyConfigure(args, agent) {
    if (ROLE_KINDS.indexOf(args.tier) !== -1) return applyRoleConfigure(args)
    for (const [key, kind] of [['subagentPolicy', 'global'], ['spawnPolicy', 'spawn'], ['forkPolicy', 'fork']]) {
      const error = args[key] === undefined ? null : kindPolicyError(kind, args[key])
      if (error) return { ok: false, message: error }
    }
    const tierName = TIER_SLOTS.indexOf(args.tier) !== -1 ? args.tier : 'cheap'
    const current = state.tiers.get(tierName)
    if (args.followSession === true && tierName === 'cheap') {
      return { ok: false, message: 'follow-session is only supported for the strong and main tiers.' }
    }
    const provider = args.provider || current.provider
    const model = args.model || current.model
    if (availableProviders().indexOf(provider) === -1) {
      return { ok: false, message: 'Provider "' + provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    const effort = args.reasoningEffort || current.reasoningEffort
    if (args.reasoningEffort) {
      const check = await validateEffortFor(provider, model, args.reasoningEffort)
      if (!check.ok) {
        return { ok: false, message: 'Rejected effort "' + args.reasoningEffort + '" for ' + provider + '/' + model + ': the model declares only ' + check.available.join(', ') + '.' }
      }
    }
    const next = migrateTierConfig(tierName, {
      followSession: typeof args.followSession === 'boolean' ? args.followSession : current.followSession,
      provider: provider,
      model: model,
      reasoningEffort: effort,
      fallback: Array.isArray(args.fallback) ? args.fallback : current.fallback,
    })
    for (const fb of next.fallback) {
      const check = await validateEffortFor(fb.provider, fb.model, fb.reasoningEffort)
      if (!check.ok) {
        return { ok: false, message: 'Rejected fallback entry ' + fb.provider + '/' + fb.model + ' with effort "' + fb.reasoningEffort + '": the model declares only ' + check.available.join(', ') + '.' }
      }
    }
    state.tiers.set(tierName, next)
    if (args.subagentPolicy) state.subagentPolicy = args.subagentPolicy
    if (args.spawnPolicy !== undefined) state.spawnPolicy = args.spawnPolicy || ''
    if (args.forkPolicy !== undefined) state.forkPolicy = args.forkPolicy || ''
    if (agent && !isChildAgent(agent) && (effectiveMode(agent) === tierName || effectiveMode(agent) === 'auto')) applyTarget(agent, effectiveTarget(agent, tierName))
    let persisted = ''
    if (args.sessionOnly !== true) persisted = await persistTierConfig()
    if (args.persist && agentDefaultModel && seams.defaultModelSave) {
      try {
        await agentDefaultModel.saveSelection({ provider: provider, model: model, reasoningEffort: effort })
        persisted += ' Saved as the session default.'
      } catch (e) {
        persisted += ' Could not persist the session default: ' + String(e && e.message || e)
      }
    }
    const applied = state.tiers.get(tierName)
    const inactive = tierName === 'main' && !state.threeTiers ? ' The main tier is inactive until /tier layout three.' : ''
    return { ok: true, message: 'Configured ' + tierName + ' tier: ' + tierLabel(applied) + (applied.followSession ? ' (follows session selection)' : '') + '; fallback: ' + chainText({ fallback: chainFor(tierName) }) + '. Subagent policy: ' + state.subagentPolicy + '.' + inactive + persisted }
  }

  function parseSetArgs(tokens) {
    const out = {}
    let i = 0
    while (i < tokens.length) {
      const tok = tokens[i]
      if (tok === '--fallback') {
        const p = tokens[i + 1]
        const m = tokens[i + 2]
        const e = tokens[i + 3]
        if (!p || !m || !e) throw new Error('usage: --fallback <provider> <model> <effort>')
        if (!out.fallback) out.fallback = []
        out.fallback.push({ provider: p, model: m, reasoningEffort: e })
        i = i + 4
      } else if (tok === 'follow-session' || tok === '--follow-session') {
        out.followSession = true
        i = i + 1
      } else if (out.provider === undefined) {
        out.provider = tok
        i = i + 1
      } else if (out.model === undefined) {
        out.model = tok
        i = i + 1
      } else if (out.effort === undefined) {
        out.effort = tok
        i = i + 1
      } else {
        throw new Error('unexpected argument "' + tok + '" (expected --fallback <provider> <model> <effort> or follow-session)')
      }
    }
    return out
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/inbox/inserted', (payload) => {
      diag.inboxSeen = diag.inboxSeen + 1
      try {
        const agent = payload && payload.agent
        const message = payload && payload.message
        if (!agent || !message) return
        if (effectiveMode(agent) === 'off') return
        try { if (!message.source || message.source.kind !== 'user') return } catch (e) {}
        captureBaseline(agent)
        if (delegatedMain(agent)) {
          const selected = captureBaseline(agent) || defaultSelectionTarget()
          if (selected) applyTarget(agent, selected)
          return
        }
        const tierName = tierNameFor(agent)
        if (tierName) applyTarget(agent, effectiveTarget(agent, tierName))
      } catch (e) {
        log(ctx, 'error', 'tier: inbox routing failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'plan/mode') return
        diag.planFlips = diag.planFlips + 1
        const active = !!(event.data && event.data.active)
        if (session && typeof session === 'object') planStates.set(session, active)
        if (session && typeof session === 'object' && active) planGates.set(session, { explored: 0, consulted: false })
        const agent = agents && seams.agentsGet ? agents.get(session.id) : undefined
        if (!agent || isChildAgent(agent)) return
        if (effectiveMode(agent) === 'off') return
        if (delegatedMain(agent)) {
          const selected = captureBaseline(agent) || defaultSelectionTarget()
          if (selected) applyTarget(agent, selected)
          return
        }
        const tierName = tierNameFor(agent, active)
        if (tierName) applyTarget(agent, effectiveTarget(agent, tierName))
      } catch (e) {
        log(ctx, 'error', 'tier: plan-flip routing failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('agent/error', async (payload) => {
      diag.errorsSeen = diag.errorsSeen + 1
      try {
        const agent = payload && payload.agent
        if (!agent) return
        const failure = payload && payload.error
        const failureText = String(failure && (failure.message || failure.code) || failure || 'unknown').slice(0, 140)
        diag.lastError = '#' + diag.errorsSeen + ' ' + agentIdentity(agent) + ': ' + failureText
        if (effectiveMode(agent) === 'off' || delegatedMain(agent)) return
        const failedTier = tierNameFor(agent)
        const decision = decideErrorActions(failure, escalations.get(agent), failedTier, 'cheap', {
          threshold: state.escalateThreshold,
          windowMs: state.escalateWindowMs,
          ttlMs: state.escalateTtlMs,
          now: Date.now(),
        })
        escalations.set(agent, decision.rec)
        if (decision.actions.indexOf('escalate') !== -1) {
          diag.escalations = diag.escalations + 1
          diag.lastEscalation = '#' + diag.escalations + ' escalated ' + agentIdentity(agent) + ' for ' + Math.round(state.escalateTtlMs / 1000) + 's after ' + decision.rec.count + ' errors'
          applyTarget(agent, effectiveTarget(agent, 'strong'))
        }
        if (decision.actions.indexOf('raise-effort') !== -1) {
          await raiseCheapEffort(agent, 'error retry (' + failureText.slice(0, 60) + ')')
        }
      } catch (e) {
        log(ctx, 'error', 'tier: error handler failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('agent/request-error', async (payload, next) => {
      try {
        const agent = payload && payload.agent
        const failure = payload && payload.failure
        if (!agent || effectiveMode(agent) === 'off' || delegatedMain(agent)) return next()
        if (classifyFallback(failure) !== 'fallback') return next()
        const tierName = tierNameFor(agent)
        if (!tierName) return next()
        const failureText = String(failure && (failure.message || failure.code) || 'unknown').slice(0, 140)
        const outcome = triggerFallback(agent, tierName, failureText)
        if (!outcome || !outcome.target) return next()
        if (seamMode === 'header') applyTarget(agent, outcome.target)
        else {
          // Waterfall mode: the retry's agent/request pass picks the fallback
          // up through activeFallbackTarget; nothing else to write.
          captureBaseline(agent)
        }
        return { kind: 'retry' }
      } catch (e) {
        log(ctx, 'error', 'tier: request-error recovery failed: ' + String(e && e.message || e))
        return next()
      }
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      diag.guardChecks = diag.guardChecks + 1
      const checkNo = diag.guardChecks
      try {
        const gated = await planToolGate(exec)
        if (gated) return gated
        const tier = effectiveExecutionTier(exec.agent)
        const hit = isHighImpact(exec.name, exec.arguments)
        const decision = decideGuardAction(tier, hit, 'cheap')
        if (decision.action === 'allow') {
          diag.lastGuard = 'check' + checkNo + ': tier=' + tier + (hit ? ' allow despite hit' : ' allow') + ' (' + agentIdentity(exec.agent) + ')'
          return next()
        }
        diag.guardDenies = diag.guardDenies + 1
        diag.lastGuard = 'check' + checkNo + ': DENIED (' + agentIdentity(exec.agent) + ') ' + String(decision.reason).slice(0, 60)
        const raised = await raiseCheapEffort(exec.agent, 'high-impact guard deny')
        const cheap = state.tiers.get('cheap')
        return {
          kind: 'deny',
          reason: decision.reason + ' — this high-impact action would execute on the cheap tier (' + tierLabel(cheap) + '). Escalate first: call tier_route with tier "strong" (or /tier strong), then re-issue the action.' + (raised.raised ? ' Cheap tier effort raised to ' + raised.effort + '.' : ''),
        }
      } catch (e) {
        diag.lastGuardError = 'check' + checkNo + ': ' + String(e && e.message || e)
        log(ctx, 'error', 'tier: guard failed: ' + String(e && e.message || e))
        return next()
      }
    })
  }

  /** The plan text of an exit_plan_mode call: its longest string argument (the markdown plan). */
  function planTextOf(args) {
    if (typeof args === 'string') return args
    let best = ''
    for (const value of Object.values(args || {})) {
      if (typeof value === 'string' && value.length > best.length) best = value
    }
    return best || JSON.stringify(args || {})
  }

  /**
   * The plan-exit gate. Runs before every tool call. While plan mode is
   * active it counts exploration calls, and before exit_plan_mode presents
   * the plan it may deny (not enough exploration) or get one advisor review
   * (denied with its advice, so the model revises the plan). Returns a deny
   * decision, or null to let the call through.
   */
  async function planToolGate(exec) {
    const agent = exec.agent
    const session = agent && agent.session
    if (!session || typeof session !== 'object' || !planActive(agent)) return null
    if (!planGates.has(session)) planGates.set(session, { explored: 0, consulted: false })
    const gate = planGates.get(session)
    if (EXPLORE_TOOLS.indexOf(exec.name) !== -1) {
      gate.explored = gate.explored + 1
      return null
    }
    if (exec.name !== 'exit_plan_mode') return null
    const decision = decidePlanExit({
      planActive: true,
      explored: gate.explored,
      minExplore: state.planMinExplore,
      advisorGate: state.planAdvisorGate,
      consulted: gate.consulted,
    })
    if (decision.action === 'deny') {
      diag.planGateDenies = diag.planGateDenies + 1
      diag.lastGate = 'deny: ' + decision.reason.slice(0, 100) + ' (' + agentIdentity(agent) + ')'
      return { kind: 'deny', reason: decision.reason }
    }
    if (decision.action !== 'consult') return null
    gate.consulted = true
    diag.planConsults = diag.planConsults + 1
    const review = await runConsult('advisor', { question: 'Is this plan ready to present for approval? Check it against the code evidence and name what must change first.', evidence: planTextOf(exec.arguments) }, exec.signal)
    if (!review.ok) {
      diag.lastGate = 'advisor unavailable: plan presented without advisor review (' + agentIdentity(agent) + ')'
      return null
    }
    diag.lastGate = 'advisor review denied the plan once (' + agentIdentity(agent) + ')'
    return { kind: 'deny', reason: 'Advisor review before presenting the plan:\n' + review.advice + '\nRevise the plan to address this, then call exit_plan_mode again.' }
  }

  if (seams.tools) {
    const statusTool = defineTool({
      name: 'tier_status',
      description: 'Report the live routing state of the tiered model routing plugin: mode, tier configuration, persistence state, seam capability report, escalation state, listener counters, the effective tier computed for the calling agent, and any last routing/guard diagnostics.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.status }] },
      },
      async execute(args, exec) {
        let effective = 'unknown'
        let identity = 'unknown'
        let escalated = false
        try {
          const guardTier = effectiveExecutionTier(exec.agent)
          effective = delegatedMain(exec.agent) ? 'session-default (delegated main; guard class ' + guardTier + ')' : guardTier
          identity = agentIdentity(exec.agent)
          escalated = isEscalated(exec.agent)
        } catch (e) {
          effective = 'error: ' + String(e && e.message || e)
        }
        let headerNow = 'none'
        try { const c = headerConfigOf(exec.agent && exec.agent.session); headerNow = c ? c.provider + '/' + c.model + '/' + (c.reasoningEffort || 'default') : 'none' } catch (e) { headerNow = 'unreadable' }
        let fallbackLine = '  fallback state: main model (no fallback active)'
        let effortLine = '  cheap effort: ' + currentCheapEffort(exec.agent)
        try {
          if (exec.agent && fallbackStates.has(exec.agent)) {
            const rec = fallbackStates.get(exec.agent)
            if (fallbackActive(rec, Date.now())) {
              const tname = rec.tierName
              const chain = tname ? chainFor(tname) : []
              fallbackLine = '  fallback state: tier=' + (tname || '?') + ' index=' + rec.index + '/' + chain.length + ' until=' + new Date(rec.until).toISOString() + ' (target ' + (chain[rec.index] ? chain[rec.index].provider + '/' + chain[rec.index].model : '?') + ')'
            }
          }
        } catch (e) {}
        const lines = [
          statusText(exec.agent),
          '  calling agent: ' + identity + (escalated ? ' (ESCALATED to strong)' : ''),
          '  effective tier for calling agent: ' + effective,
          fallbackLine,
          effortLine,
          '  current session header: ' + headerNow,
        ]
        return { status: lines.join('\n') }
      },
    })
    safeRegister('tier_status tool', () => tools.register(statusTool))

    const advisorTool = defineTool({
      name: 'tier_advisor',
      description: 'Consult the advisor model (' + consultRouteText('advisor') + ') on one hard decision before committing to an approach. Use when requirements stay ambiguous after inspection, the work implicates architecture/security/data integrity/compatibility, several root causes remain, two evidence-based attempts failed, or a high-cost judgement is needed. Provide ONE decision question plus evidence already gathered. Returns guidance to apply; implementation stays on the current model.',
      parameters: {
        question: { type: 'string', required: true, description: 'One explicit decision question, e.g. "Can the proposed cache policy expose stale authorization data?"' },
        evidence: { type: 'string', description: 'Relevant facts already collected: file paths, call graphs, outputs, errors, constraints.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            advice: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const head = value.ok ? 'Advisor (' + value.provider + '/' + value.model + '):' : 'Advisor call failed (' + value.provider + '/' + value.model + '):'
          return [{ type: 'text', text: head + '\n' + value.advice }]
        },
      },
      async execute(args, exec) {
        const r = await runConsult('advisor', args, exec.signal)
        return { advice: r.advice, ok: r.ok, tier: 'strong', provider: r.route.provider, model: r.route.model }
      },
    })
    safeRegister('tier_advisor tool', () => tools.register(advisorTool))

    const reviewTool = defineTool({
      name: 'tier_review',
      description: 'Independent review (' + consultRouteText('reviewer') + ') before declaring a task complete or merging high-risk changes. Pass the exact change set, validation commands and results, and the review focus. Returns a verdict and issues ranked by severity.',
      parameters: {
        focus: { type: 'string', required: true, description: 'What is being reviewed: the change set, files, and the risk being checked.' },
        evidence: { type: 'string', description: 'Validation results, diffs, command outputs, acceptance criteria.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', required: true },
            review: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const head = value.ok ? 'Review (' + value.provider + '/' + value.model + '): ' + value.verdict : 'Review call failed (' + value.provider + '/' + value.model + '):'
          return [{ type: 'text', text: head + '\n' + value.review }]
        },
      },
      async execute(args, exec) {
        const r = await runConsult('review', args, exec.signal)
        return { verdict: r.verdict, review: r.review, ok: r.ok, tier: 'strong', provider: r.route.provider, model: r.route.model }
      },
    })
    safeRegister('tier_review tool', () => tools.register(reviewTool))

    const routeTool = defineTool({
      name: 'tier_route',
      description: 'Set the routing mode for THIS session only (other sessions keep their own mode). strong = ' + tierLabel(state.tiers.get('strong')) + ' for hard stretches (architecture, debugging, design); cheap = ' + tierLabel(state.tiers.get('cheap')) + ' for routine implementation; auto = strong while plan mode is active and cheap while executing; delegated = keep the main agent on the session-selected model and route only subagents; off = disable per-step routing for this session and return it to its default model.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'main', 'cheap', 'auto', 'delegated', 'off'], description: 'Routing tier or delegated-only mode to apply to this session. main is active only in the three-tier layout.' },
        persist: { type: 'boolean', description: 'Also persist the choice as the session default model selection. Default false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            applied: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: 'Tier route (' + value.applied + '): ' + value.message }] },
      },
      async execute(args, exec) {
        return applyRoute(args.tier, args.persist === true, exec.agent)
      },
    })
    safeRegister('tier_route tool', () => tools.register(routeTool))

    const configureTool = defineTool({
      name: 'tier_configure',
      description: 'Configure which provider/model/effort backs each tier (strong and cheap), optional followSession mode and fallback chains, and the subagent policy. Any registered provider and model id work. Efforts are validated against the target model\'s declared reasoning efforts when metadata is available (e.g. deepseek models declare off/high/max). The configuration persists on the host profile entry (pass sessionOnly: true for a transient change); persist: true also writes the session default model.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'main', 'cheap', 'advisor', 'reviewer'], description: 'Which slot to configure: a tier (strong, main, cheap) or a consultation role (advisor, reviewer; provider/model/effort only, sharing the strong fallback chain).' },
        provider: { type: 'string', description: 'Registered provider route, e.g. "deepseek-official". Default keeps the current value.' },
        model: { type: 'string', description: 'Model id for that provider, e.g. "deepseek-v4-flash". Default keeps the current value.' },
        reasoningEffort: { type: 'string', description: 'Reasoning effort for this tier (any string; validated against the model\'s declared efforts). Default keeps the current value.' },
        followSession: { type: 'boolean', description: 'Strong tier only: when true the primary model follows the session model selection; the explicit provider/model/effort remain as the fallback base.' },
        fallback: { type: 'json', description: 'Optional ordered fallback chain: [{ provider, model, reasoningEffort }]. Default keeps the current chain.' },
        subagentPolicy: { type: 'string', enum: SUBAGENT_POLICIES, description: 'Optional: how subagent steps route, for both kinds unless spawnPolicy/forkPolicy overrides it. inherit = same rules as the main agent (mode and plan state); cheap, strong or main = fixed tier; caller = the parent\'s current route; capped = the parent\'s route but never above main (cheap in two tiers).' },
        spawnPolicy: { type: 'string', enum: ['', ...SUBAGENT_POLICIES.filter((p) => p !== 'caller')], description: 'Optional override for spawn children (the built-in subagent tool). Empty = use subagentPolicy. caller is refused for spawn.' },
        forkPolicy: { type: 'string', enum: ['', ...SUBAGENT_POLICIES], description: 'Optional override for fork children (subagent_fork). Empty = use subagentPolicy.' },
        sessionOnly: { type: 'boolean', description: 'Keep the change in-memory only (default false = persist to settings).' },
        persist: { type: 'boolean', description: 'Also save this tier as the session default model selection. Default false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.message }] },
      },
      async execute(args, exec) {
        return applyConfigure(args, exec.agent)
      },
    })
    safeRegister('tier_configure tool', () => tools.register(configureTool))

    const escalateEffortTool = defineTool({
      name: 'tier_escalate_effort',
      description: 'Raise the cheap-tier reasoning effort one step for the calling agent (low -> medium -> high -> max, bounded by what the cheap model actually declares). Call when the current task is harder than the cheap tier baseline: more reasoning effort may avoid further failed attempts.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            effort: { type: 'string' },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.message }] },
      },
      async execute(args, exec) {
        const r = await raiseCheapEffort(exec.agent, 'tier_escalate_effort tool')
        return { ok: r.raised, effort: r.effort || undefined, message: r.message }
      },
    })
    safeRegister('tier_escalate_effort tool', () => tools.register(escalateEffortTool))

    const workerTool = defineTool({
      name: 'tier_worker',
      description: 'Delegate a bounded task packet to a fresh subagent that runs on a chosen tier: cheap (configured as ' + tierLabel(state.tiers.get('cheap')) + ') for routine implementation, main (configured as ' + tierLabel(state.tiers.get('main')) + ', three-tier layout only) for the default work, or strong (configured as ' + tierLabel(state.tiers.get('strong')) + ') for hard analysis. Optional: outputSchema for a structured result, agentPreset to compose the worker from a different agent preset (spawn provider), maxDepth to cap delegation depth, background to run via the jobs service. Returns the worker\'s final output (or structured result) and stop reason.',
      parameters: {
        task: { type: 'string', required: true, description: 'Complete self-contained task packet for the worker: objective, in-scope/out-of-scope, constraints, expected return.' },
        tier: { type: 'string', enum: ['cheap', 'main', 'strong'], description: 'Tier the worker subagent runs on. Default cheap. main requires the three-tier layout.' },
        provider: { type: 'string', description: 'Subagent provider name. Default: the first registered provider.' },
        outputSchema: { type: 'json', description: 'Optional object-rooted JSON Schema (supported subset) for a structured result; the worker returns a validated value.' },
        agentPreset: { type: 'string', description: 'Optional agent preset id composing the worker (spawn provider only); replaces the retired persona/toolFilter options.' },
        maxDepth: { type: 'integer', description: 'Optional absolute delegation-depth cap for the worker and its descendants.' },
        background: { type: 'boolean', description: 'Run the worker as a background job instead of blocking. Requires the jobs service.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            output: { type: 'string', required: true },
            structured: { type: 'json' },
            stopReason: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
            background: { type: 'boolean' },
            jobId: { type: 'string' },
          },
        },
        render(args, value) {
          const head = 'Worker (' + value.tier + ' tier, ' + value.provider + '/' + value.model + ', ' + value.stopReason + '):'
          const body = value.structured !== undefined ? 'structured=' + JSON.stringify(value.structured).slice(0, 200) : value.output
          return [{ type: 'text', text: head + '\n' + body }]
        },
      },
      async execute(args, exec) {
        if (!subagents || (!seams.subagentsActivation && !seams.subagentsLegacy)) throw new Error('tier_worker: subagents service is not mounted or has no compatible start API')
        const names = seams.subagentsList ? subagents.list() : []
        // agentPreset is declared by the spawn provider; prefer it when one
        // is requested or when it is the only registered provider.
        let providerName = args.provider || null
        if (!providerName && args.agentPreset && names.indexOf('spawn') !== -1) providerName = 'spawn'
        if (!providerName) providerName = names.indexOf('spawn') !== -1 ? 'spawn' : (names.length > 0 ? names[0] : null)
        if (!providerName) throw new Error('tier_worker: no subagent provider registered')
        const tierName = args.tier === 'strong' || args.tier === 'main' ? args.tier : 'cheap'
        if (tierName === 'main' && !state.threeTiers) throw new Error('tier_worker: the main tier is inactive; enable the three-tier layout first (/tier layout three)')
        const tier = state.tiers.get(tierName)
        if (availableProviders().indexOf(tier.provider) === -1) {
          throw new Error('tier_worker: provider "' + tier.provider + '" is not registered. Registered: ' + availableProviders().join(', '))
        }
        const parent = exec.agent
        if (!parent) throw new Error('tier_worker: requires a calling agent')
        const spec = {
          provider: providerName,
          label: String(args.task).slice(0, 100),
          prompt: [{ type: 'text', text: String(args.task) }],
          parent: parent,
          // Supply the complete route at creation instead of rewriting the
          // model-selection waterfall downstream.
          agentOptions: {
            provider: tier.provider,
            model: tier.model,
            reasoningEffort: tier.reasoningEffort,
          },
          signal: exec.signal,
        }
        if (args.outputSchema && typeof args.outputSchema === 'object' && !Array.isArray(args.outputSchema)) spec.outputSchema = args.outputSchema
        if (args.agentPreset && typeof args.agentPreset === 'string') spec.agentPreset = args.agentPreset
        if (typeof args.maxDepth === 'number' && Number.isInteger(args.maxDepth) && args.maxDepth >= 0) spec.maxDepth = args.maxDepth

        const settleRun = async (run) => {
          let childAgent = run.localAgent || null
          if (!childAgent && run.childId && agents && seams.agentsGet) {
            try { childAgent = agents.get(run.childId) || null } catch (e) {}
          }
          if (childAgent && childAgent !== parent) childTiers.set(childAgent, tierName)
          let result = null
          try {
            result = await run.result
          } finally {
            try { await run.dispose() } catch (e) {}
          }
          const out = []
          if (result && Array.isArray(result.output)) {
            for (const block of result.output) {
              if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text)
            }
          }
          const res = {
            output: out.join('\n').trim(),
            stopReason: result ? String(result.stopReason) : 'unknown',
            tier: tierName,
            provider: tier.provider,
            model: tier.model,
          }
          if (result && result.structured !== undefined) res.structured = result.structured
          return res
        }

        if (args.background === true && seams.jobsStart) {
          const controller = new AbortController()
          const jobId = startBackgroundJob(jobs, {
            kind: 'subagent',
            label: String(args.task).slice(0, 100),
            ownerAgent: parent,
            run: () => ({
              cancel: (reason) => {
                controller.abort(reason ?? 'tier_worker background job killed')
              },
              // The jobs contract: done resolves to a JobOutcome —
              // { status: 'completed'|'killed'|'failed', detail?, output? } —
              // and must not reject.
              done: (async () => {
                try {
                  const run = await startWorker(subagents, { ...spec, signal: controller.signal })
                  const res = await settleRun(run)
                  return {
                    status: 'completed',
                    detail: 'tier=' + res.tier + ' model=' + res.provider + '/' + res.model + ' stopReason=' + res.stopReason,
                    output: res.structured !== undefined ? 'structured=' + JSON.stringify(res.structured) : res.output,
                  }
                } catch (e) {
                  return {
                    status: controller.signal.aborted ? 'killed' : 'failed',
                    detail: String(e && e.message || e),
                  }
                }
              })(),
            }),
          })
          return {
            output: 'started background worker',
            stopReason: 'background',
            tier: tierName,
            provider: tier.provider,
            model: tier.model,
            background: true,
            // jobs.start may return a bare id or a Job object depending on
            // the host build — normalize instead of printing [object Object].
            jobId: String(jobId && typeof jobId === 'object' ? (jobId.id || jobId.jobId || JSON.stringify(jobId)) : jobId),
          }
        }
        if (args.background === true && !seams.jobsStart) {
          throw new Error('tier_worker: background mode requested but the jobs service is not mounted')
        }

        const run = await startWorker(subagents, spec)
        return settleRun(run)
      },
    })
    safeRegister('tier_worker tool', () => tools.register(workerTool))
  }

  if (seams.commands) {
    safeRegister('/advisor command', () => commands.register({
      name: 'advisor',
      description: 'Consult the strong-tier advisor on one hard question',
      input: { hint: 'one decision question, optionally followed by evidence' },
      handler: async (invocation) => {
        const q = String(invocation.rawInput || '').trim()
        if (!q) return { kind: 'success', text: statusText(invocation.agent) }
        try {
          const r = await runConsult('advisor', { question: q }, invocation.signal)
          return { kind: 'success', text: 'Advisor (' + r.route.provider + '/' + r.route.model + '):\n' + r.advice }
        } catch (e) {
          return { kind: 'error', text: 'advisor failed: ' + String(e && e.message || e) }
        }
      },
    }))

    safeRegister('/tier command', () => commands.register({
      name: 'tier',
      description: 'Control tiered model routing',
      input: { hint: 'status | strong | main | cheap | auto | delegated | off | plan | models | layout <two|three> | roles <on|off> | gate explore <n> | gate advisor <on|off> | set <strong|main|cheap|advisor|reviewer> <provider> <model> [effort] [--fallback <p> <m> <e> ...] | set <strong|main> follow-session | effort <low|medium|high|max> | subagent <inherit|cheap|strong> | review <focus>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        const parts = raw.split(/\s+/)
        const sub = (parts[0] || 'status').toLowerCase()
        const rest = parts.slice(1)
        const arg = rest.join(' ')
        try {
          if (sub === 'status') return { kind: 'success', text: statusText(invocation.agent) }
          if (sub === 'strong') { const r = await applyRoute('strong', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'main') { const r = await applyRoute('main', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'cheap') { const r = await applyRoute('cheap', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'layout') {
            const layout = rest[0]
            if (layout !== 'two' && layout !== 'three') return { kind: 'error', text: 'usage: /tier layout <two|three>' }
            state.threeTiers = layout === 'three'
            const saved = await persistTierConfig()
            return { kind: 'success', text: state.threeTiers
              ? 'Three-tier layout on: strong = escalation tier, main = plan mode, cheap = execution.' + saved
              : 'Two-tier layout on: strong = plan mode, cheap = execution.' + saved }
          }
          if (sub === 'gate') {
            const what = rest[0]
            if (what === 'explore') {
              const n = Number(rest[1])
              if (!Number.isInteger(n) || n < 0) return { kind: 'error', text: 'usage: /tier gate explore <n>  (read/search calls required before exit_plan_mode; 0 disables)' }
              state.planMinExplore = n
            } else if (what === 'advisor') {
              if (rest[1] !== 'on' && rest[1] !== 'off') return { kind: 'error', text: 'usage: /tier gate advisor <on|off>' }
              state.planAdvisorGate = rest[1] === 'on'
            } else {
              return { kind: 'error', text: 'usage: /tier gate explore <n> | /tier gate advisor <on|off>' }
            }
            const saved = await persistTierConfig()
            return { kind: 'success', text: 'Plan gate: explore >= ' + state.planMinExplore + ' before exit_plan_mode, advisor review ' + (state.planAdvisorGate ? 'on' : 'off') + '.' + saved }
          }
          if (sub === 'roles') {
            const on = rest[0]
            if (on !== 'on' && on !== 'off') return { kind: 'error', text: 'usage: /tier roles <on|off>' }
            state.rolesEnabled = on === 'on'
            const saved = await persistTierConfig()
            return { kind: 'success', text: state.rolesEnabled
              ? 'Roles on: advisor and reviewer use their own routes (fallback: the strong chain).' + saved
              : 'Roles off: advisor and reviewer use the strong route.' + saved }
          }
          if (sub === 'auto') { const r = await applyRoute('auto', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'delegated') { const r = await applyRoute('delegated', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'off') { const r = await applyRoute('off', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'models') { return { kind: 'success', text: 'Registered providers and models:\n' + await listModelsText() } }
          if (sub === 'set') {
            const tier = rest[0]
            const usage = 'usage: /tier set <strong|main|cheap|advisor|reviewer> <provider> <model> [effort] [--fallback <p> <m> <e> ...] | /tier set <strong|main> follow-session'
            if (TIER_SLOTS.indexOf(tier) === -1 && ROLE_KINDS.indexOf(tier) === -1) return { kind: 'error', text: usage }
            let parsed
            try {
              parsed = parseSetArgs(rest.slice(1))
            } catch (e) {
              return { kind: 'error', text: String(e && e.message || e) }
            }
            if (parsed.followSession && parsed.provider) {
              return { kind: 'error', text: 'follow-session cannot be combined with a provider/model; use /tier set ' + tier + ' follow-session' }
            }
            if (!parsed.followSession && (!parsed.provider || !parsed.model)) {
              return { kind: 'error', text: usage }
            }
            const r = await applyConfigure({ tier: tier, provider: parsed.provider, model: parsed.model, reasoningEffort: parsed.effort, followSession: parsed.followSession, fallback: parsed.fallback, sessionOnly: false, persist: false }, invocation.agent)
            return { kind: r.ok ? 'success' : 'error', text: r.message }
          }
          if (sub === 'effort') {
            const effort = rest[0]
            if (EFFORT_LADDER.indexOf(effort) === -1) return { kind: 'error', text: 'usage: /tier effort <low|medium|high|max>' }
            if (!invocation.agent) return { kind: 'error', text: 'tier effort requires a calling agent (per-session state).' }
            const cheap = state.tiers.get('cheap')
            const check = await validateEffortFor(cheap.provider, cheap.model, effort)
            if (!check.ok) return { kind: 'error', text: 'Rejected effort "' + effort + '" for ' + cheap.provider + '/' + cheap.model + ': the model declares only ' + check.available.join(', ') + '.' }
            cheapEfforts.set(invocation.agent, { effort: effort, until: 0 })
            diag.lastEffort = 'manual cheap effort set to ' + effort + ' for ' + agentIdentity(invocation.agent)
            return { kind: 'success', text: 'Cheap tier effort set to "' + effort + '" for this session (applies while the cheap tier executes).' }
          }
          if (sub === 'subagent') {
            const kind = rest[0] === 'spawn' || rest[0] === 'fork' ? rest[0] : null
            const policy = kind ? rest[1] : rest[0]
            const usage = 'usage: /tier subagent [spawn|fork] <inherit|cheap|strong|main|caller|capped>'
            if (SUBAGENT_POLICIES.indexOf(policy) === -1) return { kind: 'error', text: usage }
            const refused = kindPolicyError(kind || 'global', policy)
            if (refused) return { kind: 'error', text: refused }
            if (kind === 'spawn') state.spawnPolicy = policy
            else if (kind === 'fork') state.forkPolicy = policy
            else state.subagentPolicy = policy
            const saved = await persistTierConfig()
            return { kind: 'success', text: 'Subagent policy set to "' + policy + '".' + saved }
          }
          if (sub === 'plan') {
            if (!invocation.agent) return { kind: 'error', text: 'tier plan requires a calling agent (per-session state).' }
            sessionModes.set(invocation.agent, 'auto')
            clearRoutingTransients(invocation.agent)
            const outcome = setPlanMode(invocation.agent, true)
            applyTarget(invocation.agent, effectiveTarget(invocation.agent, planTierName()))
            return { kind: 'success', text: 'Routing set to auto (' + planTierName() + ' plans, cheap executes). Plan mode: ' + outcome + '.' }
          }
          if (sub === 'review') {
            if (!arg) return { kind: 'error', text: 'usage: /tier review <focus to review>' }
            const r = await runConsult('review', { focus: arg }, invocation.signal)
            return { kind: 'success', text: 'Review (' + r.route.provider + '/' + r.route.model + '):\n' + r.review }
          }
          return { kind: 'error', text: 'Unknown subcommand "' + sub + '". Use: status | strong | main | cheap | auto | delegated | off | plan | models | layout | roles | set | effort | subagent | review' }
        } catch (e) {
          return { kind: 'error', text: 'tier command failed: ' + String(e && e.message || e) }
        }
      },
    }))
  }

  if (seams.systemPrompt) {
    safeRegister('prompt section', () => systemPrompt.section({
      name: 'tier-routing',
      order: 120,
      text: function () {
        const strong = state.tiers.get('strong')
        const cheap = state.tiers.get('cheap')
        return [
          '## Tiered model routing',
          'This session uses tiered routing (' + (state.threeTiers ? 'three tiers' : 'two tiers') + '): strong = ' + tierLabel(strong) + (strong.followSession ? ' (follows your session model selection)' : '') + (state.threeTiers ? '; main = ' + tierLabel(state.tiers.get('main')) : '') + '; cheap = ' + tierLabel(cheap) + '. Fallback chains: strong -> ' + chainText({ fallback: chainFor('strong') }) + '; cheap -> ' + chainText({ fallback: chainFor('cheap') }) + '. Global routing default: ' + state.mode + ' (a per-session override may apply in this session); subagent policy: ' + state.subagentPolicy + '.',
          '- In auto mode, the session model follows plan state: plan mode runs on the ' + planTierName() + ' tier, execution on the cheap tier (applied per request). In delegated mode, the main agent stays on the session-selected model and only subagents are tier-routed.',
          '- A deterministic guard denies high-impact tool calls (rm -rf, sudo, force push, credential/secret file edits, ...) while the cheap tier executes: call `tier_route` with tier "strong" first, then re-issue the action.',
          '- Repeated model-step errors automatically escalate the session to the strong tier for a few minutes (failure auto-escalation; inactive in off mode).',
          '- Each tier has a fallback chain: if the primary model is unavailable (quota, rate limit, unknown model, credential or 5xx errors), the next chain entry runs the same task, then the tier returns to its primary after ' + Math.round(state.fallbackTtlMs / 1000) + 's. The cheap tier starts at low reasoning effort and raises itself (to medium/high/max, bounded by what the model declares) when a task proves hard; you may call "tier_escalate_effort" or /tier effort <low|medium|high|max> to set it explicitly.',
          '- Delegate bounded implementation packets to `tier_worker` (cheap tier by default; use tier "strong" for hard analysis). You may pass outputSchema for structured results, agentPreset to compose the worker from a different preset (spawn provider), maxDepth to cap delegation depth, and background to run via the jobs service.',
          '- Before committing to an approach, call `tier_advisor` when: requirements stay ambiguous after inspection; the work implicates architecture, security, authentication, data integrity, destructive migration, or compatibility and a decision is needed; several plausible root causes remain after the cheapest checks; two evidence-based attempts failed; or final validation exposes a high-cost unresolved risk. Provide ONE decision question plus the evidence already collected.',
          '- Call `tier_review` before declaring a high-risk task complete: pass the exact change set and validation results.',
          '- Use `tier_route` to switch tiers for a stretch of work; use `tier_configure` to change which provider/model backs each tier; use `tier_status` to inspect routing state and seam health.',
          '- Never claim a tier or model ran unless a tool result or request header identifies it.',
        ].join('\n')
      },
    }))
  }

  log(ctx, 'info', 'tier: active — seam=' + seamMode + ' mode=' + state.mode + ' strong=' + tierLabel(state.tiers.get('strong')) + ' cheap=' + tierLabel(state.tiers.get('cheap')) + ' subagentPolicy=' + state.subagentPolicy + ' persist=' + (bridge.readable ? 'settings:' + HOST_SETTINGS_NS : 'memory') + ' seams: ' + seamReport(seams))
}
