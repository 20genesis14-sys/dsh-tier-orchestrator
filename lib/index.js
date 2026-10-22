// dsh-tier-orchestrator — Tiered model routing for DeepSeek Harness.
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
import { escalationActive, escalationExpired, decideGuardAction, decideErrorActions, decidePlanExit, decideAdvisorBudget, EXPLORE_TOOLS } from './core/policy.js'
import { consultSpec, modelFamily, reviewerConflicts } from './core/consult.js'
import {
  buildGuardQuestions, buildTierQuestion, buildEscalationQuestion, buildConsultQuestion,
  buildDecisionState, isDecisionStageEnabled, DECISION_STAGES,
} from './core/decision.js'
import { createDiag } from './core/metrics.js'
import { sidekickSpec, resolveSidekickTarget, formatCard, formatMemoryBlock, digestStagesFor, WORKER_STAGE, parseChangeReport, SIDEKICK_STAGES } from './core/sidekick.js'
import { probeServices, seamReport } from './dsh/services.js'
import { mountRequestWaterfall, headerConfigOf, applyHeaderRoute } from './dsh/routing-seam.js'
import { startWorker } from './dsh/subagents.js'
import { startBackgroundJob } from './dsh/jobs.js'
import { createConfigBridge, vol, isMaskedSecret, HOST_SETTINGS_NS } from './dsh/config.js'
import { createModelCapabilities } from './dsh/model-capabilities.js'
import { createVecCache, readEvidencePaths, CACHE_FILE_NAME } from './dsh/vec-cache.js'
import { createDecisionClient } from './dsh/decisions.js'
import { createMinimalFsTools } from './minimal-fs-tools.js'
import { tierPromptSection } from './core/prompt-section.js'

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
  mode: z.union(['auto', 'strong', 'cheap', 'delegated', 'off', 'smart']).default('auto').volatile(),
  strongProvider: z.string().default('deepseek-official').volatile(),
  strongModel: z.string().default('deepseek-v4-pro').volatile(),
  strongEffort: z.string().default('max').volatile(),
  // Mirrors DEFAULT_TIER_CONFIG.strong: a first provider refusal retries the
  // same route once. A bare row without this field must not silently lose the
  // documented self-fallback.
  strongFallback: z.array(fallbackEntrySchema).default([{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }]).volatile(),
  cheapProvider: z.string().default('deepseek-official').volatile(),
  cheapModel: z.string().default('deepseek-v4-flash').volatile(),
  cheapEffort: z.string().default('low').volatile(),
  cheapFallback: z.array(fallbackEntrySchema).default([]).volatile(),
  threeTiers: z.boolean().default(false).volatile(),
  mainProvider: z.string().default('deepseek-official').volatile(),
  mainModel: z.string().default('deepseek-v4-pro').volatile(),
  mainEffort: z.string().default('high').volatile(),
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
  sidekickExploreProvider: z.string().default('').volatile(),
  sidekickExploreModel: z.string().default('').volatile(),
  sidekickExploreEffort: z.string().default('').volatile(),
  sidekickImplementProvider: z.string().default('').volatile(),
  sidekickImplementModel: z.string().default('').volatile(),
  sidekickImplementEffort: z.string().default('').volatile(),
  sidekickFixProvider: z.string().default('').volatile(),
  sidekickFixModel: z.string().default('').volatile(),
  sidekickFixEffort: z.string().default('').volatile(),
  advisorMaxCallsPerTurn: z.number().default(2).volatile(),
  advisorConfirmTimeoutSec: z.number().default(30).volatile(),
  forceTierOnExplicitModel: z.boolean().default(false).volatile(),
  decisionModel: z.string().default('').volatile(),
  decisionBaseUrl: z.string().default('').volatile(),
  decisionPath: z.string().default('/api/alpha/decisions').volatile(),
  decisionApiKey: z.string().default('').volatile(),
  // Where the decision-model list is read from. The default is the public
  // OpenRouter models catalog, filtered to the models that answer with
  // decisions; the API key is never sent with that request.
  decisionCatalogPath: z.string().default('/api/v1/models').volatile(),
  decisionCatalogQuery: z.string().default('output_modalities=decisions&limit=100').volatile(),
  decisionStages: z.array(z.union(DECISION_STAGES)).default([]).volatile(),
  decisionApproveAt: z.number().default(0.9).volatile(),
  decisionBlockAt: z.number().default(0.1).volatile(),
  decisionTimeoutMs: z.number().default(8000).volatile(),
  decisionBudgetPerTurn: z.number().default(10).volatile(),
  // Agent-row prompt composition. Non-volatile: set per preset in
  // cordis.patch.yml, not editable per session.
  promptMode: z.union(['standard', 'pi']).default('standard'),
  // Host-row informational default (which preset new sessions should use).
  // Not read by the routing logic; documented for users and the WebUI.
  promptProfile: z.union(['standard', 'pi']).default('standard').volatile(),
})

const ROLE_KINDS = ['advisor', 'reviewer']
const TIER_SLOTS = ['strong', 'main', 'cheap']
// Consultation kind -> the role that routes it.
const CONSULT_ROLE = { advisor: 'advisor', review: 'reviewer' }

const MODES = ['auto', 'strong', 'cheap', 'delegated', 'off', 'smart']

const SIDEKICK_STAGE_KEYS = {
  explore: ['sidekickExploreProvider', 'sidekickExploreModel', 'sidekickExploreEffort'],
  implement: ['sidekickImplementProvider', 'sidekickImplementModel', 'sidekickImplementEffort'],
  fix: ['sidekickFixProvider', 'sidekickFixModel', 'sidekickFixEffort'],
}

// Tools the Main Agent may not call directly in smart mode (delegate to
// tier_sidekick instead).
const SMART_MAIN_BLOCKED_TOOLS = ['write', 'edit', 'multi_edit', 'patch']

function log(ctx, level, message) {
  const logger = ctx && ctx.logger
  if (logger && typeof logger[level] === 'function') logger[level](message)
  else if (level === 'warn' || level === 'error') console.error(message)
  else console.log(message)
}

// ---- path helpers (cache bookkeeping) --------------------------------------

/** Normalize a path for comparison: forward slashes, no trailing slash. */
function normalizePath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/')
  const absolute = s.startsWith('/')
  const parts = []
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // Collapse a parent segment so `/work/proj/../../etc/x` cannot pass a
      // prefix check against `/work/proj`.
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  if (absolute) return '/' + parts.join('/')
  return parts.length > 0 ? parts.join('/') : '.'
}

/** True for an absolute path (POSIX, Windows drive or UNC). */
function isAbsolutePath(p) {
  const s = String(p || '')
  return s.startsWith('/') || /^[A-Za-z]:\//.test(s) || s.startsWith('//')
}

/**
 * True when `p` is the root itself or lives inside it. An unknown root proves
 * nothing, so it is *not* treated as containing every path.
 */
function isInsideRoot(p, root) {
  if (!root) return false
  const a = normalizePath(p).toLowerCase()
  const b = normalizePath(root).toLowerCase()
  if (b === '/') return a.startsWith('/')
  return a === b || a.startsWith(b + '/')
}

export function apply(ctx, config = {}) {
  const plane = vol(config.plane) || 'host'
  if (plane !== 'agent') {
    // Host row: exists to carry the volatile configuration (auto-generated
    // WebUI settings page + profile persistence). Nothing else to mount.
    log(ctx, 'info', 'tier: host row active — tier configuration is editable in Settings')
    return
  }
  const promptMode = vol(config.promptMode) === 'pi' ? 'pi' : 'standard'
  applyAgentPlane(ctx, promptMode)
}

function applyAgentPlane(ctx, promptMode = 'standard') {
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
    sidekick: { explore: null, implement: null, fix: null },
    advisorMaxCallsPerTurn: 2,
    advisorConfirmTimeoutSec: 30,
    forceTierOnExplicitModel: false,
    decisionModel: '',
    decisionBaseUrl: '',
    decisionPath: '/api/alpha/decisions',
    decisionApiKey: '',
    decisionCatalogPath: '/api/v1/models',
    decisionCatalogQuery: 'output_modalities=decisions&limit=100',
    decisionStages: [],
    decisionApproveAt: 0.9,
    decisionBlockAt: 0.1,
    decisionTimeoutMs: 8000,
    decisionBudgetPerTurn: 10,
    promptProfile: 'standard',
  }

  const childTiers = new WeakMap()
  const sessionModes = new WeakMap()
  const sessionBaselines = new WeakMap()
  const escalations = new WeakMap()
  const fallbackStates = new WeakMap()
  const cheapEfforts = new WeakMap()
  // Children whose seed route must be preserved verbatim (sidekick spawns
  // carry their stage model in the seed).
  const childKeepSeed = new WeakMap()
  // Children whose route is decided at spawn but whose seed is preserved: the
  // guard must know the tier they actually execute on (a sidekick implements
  // on the cheap tier, so a keep-seed child must not look like "strong").
  // Value: a tier name (an unknown stage model is recorded as the weak tier).
  const childRouteTiers = new WeakMap()
  // Explicit child routes announced before the spawn returns: the child's
  // first request can race `childTiers.set()` in the caller. Bounded and
  // expiring; a pin is claimed by the child's first request whose seed matches
  // its route, and withdrawn when the spawn fails.
  const pendingChildPins = []
  const PENDING_PIN_MAX = 16
  const PENDING_PIN_TTL_MS = 300000
  // Per-agent advisor calls in the current user turn.
  const advisorTurnCalls = new WeakMap()
  // Per-agent decision-model calls in the current user turn (like advisor).
  const decisionTurnCalls = new WeakMap()
  // Last substantive user task text per agent (feeds guard `serves_task`).
  const lastTasks = new WeakMap()
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
    for (const k of ['mode', 'strongProvider', 'strongModel', 'strongEffort', 'strongFallback', 'cheapProvider', 'cheapModel', 'cheapEffort', 'cheapFallback', 'threeTiers', 'mainProvider', 'mainModel', 'mainEffort', 'mainFallback', 'rolesEnabled', 'advisorProvider', 'advisorModel', 'advisorEffort', 'reviewerProvider', 'reviewerModel', 'reviewerEffort', 'subagentPolicy', 'spawnPolicy', 'forkPolicy', 'planMinExplore', 'planAdvisorGate', 'sidekickExploreProvider', 'sidekickExploreModel', 'sidekickExploreEffort', 'sidekickImplementProvider', 'sidekickImplementModel', 'sidekickImplementEffort', 'sidekickFixProvider', 'sidekickFixModel', 'sidekickFixEffort', 'advisorMaxCallsPerTurn', 'advisorConfirmTimeoutSec', 'forceTierOnExplicitModel', 'decisionModel', 'decisionBaseUrl', 'decisionPath', 'decisionApiKey', 'decisionCatalogPath', 'decisionCatalogQuery', 'decisionStages', 'decisionApproveAt', 'decisionBlockAt', 'decisionTimeoutMs', 'decisionBudgetPerTurn', 'promptProfile']) {
      value[k] = vol(rawValue[k])
    }
    if (MODES.indexOf(value.mode) !== -1) state.mode = value.mode
    state.threeTiers = value.threeTiers === true
    state.rolesEnabled = value.rolesEnabled === true
    state.tiers.set('strong', migrateTierConfig('strong', {
      provider: value.strongProvider,
      model: value.strongModel,
      reasoningEffort: value.strongEffort,
      fallback: value.strongFallback,
    }))
    state.tiers.set('main', migrateTierConfig('main', {
      provider: value.mainProvider,
      model: value.mainModel,
      reasoningEffort: value.mainEffort,
      fallback: value.mainFallback,
    }))
    state.tiers.set('cheap', migrateTierConfig('cheap', {
      provider: value.cheapProvider,
      model: value.cheapModel,
      reasoningEffort: value.cheapEffort,
      fallback: value.cheapFallback,
    }))
    state.roles = { advisor: roleFrom(value, 'advisor'), reviewer: roleFrom(value, 'reviewer') }
    if (SUBAGENT_POLICIES.indexOf(value.subagentPolicy) !== -1) state.subagentPolicy = value.subagentPolicy
    state.spawnPolicy = loadKindPolicy('spawn', value.spawnPolicy)
    state.forkPolicy = loadKindPolicy('fork', value.forkPolicy)
    if (typeof value.planMinExplore === 'number' && value.planMinExplore >= 0) state.planMinExplore = Math.floor(value.planMinExplore)
    state.planAdvisorGate = value.planAdvisorGate === true || (value.planAdvisorGate === undefined && state.planAdvisorGate)
    for (const stage of SIDEKICK_STAGES) {
      const [pk, mk, ek] = SIDEKICK_STAGE_KEYS[stage]
      const provider = typeof value[pk] === 'string' ? value[pk] : ''
      const model = typeof value[mk] === 'string' ? value[mk] : ''
      if (provider && model) {
        state.sidekick[stage] = {
          provider,
          model,
          reasoningEffort: typeof value[ek] === 'string' ? value[ek] : '',
        }
      } else {
        state.sidekick[stage] = null
      }
    }
    if (typeof value.advisorMaxCallsPerTurn === 'number' && value.advisorMaxCallsPerTurn >= 0) {
      state.advisorMaxCallsPerTurn = Math.floor(value.advisorMaxCallsPerTurn)
    }
    if (typeof value.advisorConfirmTimeoutSec === 'number' && value.advisorConfirmTimeoutSec >= 0) {
      state.advisorConfirmTimeoutSec = Math.floor(value.advisorConfirmTimeoutSec)
    }
    state.forceTierOnExplicitModel = value.forceTierOnExplicitModel === true
    if (typeof value.decisionModel === 'string') state.decisionModel = value.decisionModel
    if (typeof value.decisionBaseUrl === 'string') state.decisionBaseUrl = value.decisionBaseUrl
    if (typeof value.decisionPath === 'string' && value.decisionPath) state.decisionPath = value.decisionPath
    // A host may mask the stored key in describe(): never treat the mask as
    // the key, or the next persist writes it back over the real one.
    if (typeof value.decisionApiKey === 'string' && !isMaskedSecret(value.decisionApiKey)) state.decisionApiKey = value.decisionApiKey
    if (typeof value.decisionCatalogPath === 'string' && value.decisionCatalogPath) {
      state.decisionCatalogPath = value.decisionCatalogPath
    }
    if (typeof value.decisionCatalogQuery === 'string') state.decisionCatalogQuery = value.decisionCatalogQuery
    if (Array.isArray(value.decisionStages)) {
      state.decisionStages = value.decisionStages.filter(function (s) { return DECISION_STAGES.indexOf(s) !== -1 })
    }
    if (typeof value.decisionApproveAt === 'number' && Number.isFinite(value.decisionApproveAt)) {
      state.decisionApproveAt = Math.min(1, Math.max(0, value.decisionApproveAt))
    }
    if (typeof value.decisionBlockAt === 'number' && Number.isFinite(value.decisionBlockAt)) {
      state.decisionBlockAt = Math.min(1, Math.max(0, value.decisionBlockAt))
    }
    if (typeof value.decisionTimeoutMs === 'number' && Number.isFinite(value.decisionTimeoutMs)) {
      state.decisionTimeoutMs = Math.max(500, Math.floor(value.decisionTimeoutMs))
    }
    if (typeof value.decisionBudgetPerTurn === 'number' && Number.isFinite(value.decisionBudgetPerTurn)) {
      state.decisionBudgetPerTurn = Math.max(0, Math.floor(value.decisionBudgetPerTurn))
    }
    if (value.promptProfile === 'pi' || value.promptProfile === 'standard') state.promptProfile = value.promptProfile
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
        strongFallback: strong.fallback,
        threeTiers: state.threeTiers,
        mainProvider: main.provider,
        mainModel: main.model,
        mainEffort: main.reasoningEffort,
        mainFallback: main.fallback,
        cheapProvider: cheap.provider,
        cheapModel: cheap.model,
        cheapEffort: cheap.reasoningEffort,
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
        sidekickExploreProvider: (state.sidekick.explore || { provider: '' }).provider,
        sidekickExploreModel: (state.sidekick.explore || { model: '' }).model,
        sidekickExploreEffort: (state.sidekick.explore || { reasoningEffort: '' }).reasoningEffort || '',
        sidekickImplementProvider: (state.sidekick.implement || { provider: '' }).provider,
        sidekickImplementModel: (state.sidekick.implement || { model: '' }).model,
        sidekickImplementEffort: (state.sidekick.implement || { reasoningEffort: '' }).reasoningEffort || '',
        sidekickFixProvider: (state.sidekick.fix || { provider: '' }).provider,
        sidekickFixModel: (state.sidekick.fix || { model: '' }).model,
        sidekickFixEffort: (state.sidekick.fix || { reasoningEffort: '' }).reasoningEffort || '',
        advisorMaxCallsPerTurn: state.advisorMaxCallsPerTurn,
        advisorConfirmTimeoutSec: state.advisorConfirmTimeoutSec,
        forceTierOnExplicitModel: state.forceTierOnExplicitModel,
        decisionModel: state.decisionModel,
        decisionBaseUrl: state.decisionBaseUrl,
        decisionPath: state.decisionPath,
        decisionApiKey: state.decisionApiKey,
        decisionCatalogPath: state.decisionCatalogPath,
        decisionCatalogQuery: state.decisionCatalogQuery,
        decisionStages: state.decisionStages,
        decisionApproveAt: state.decisionApproveAt,
        decisionBlockAt: state.decisionBlockAt,
        decisionTimeoutMs: state.decisionTimeoutMs,
        decisionBudgetPerTurn: state.decisionBudgetPerTurn,
        promptProfile: state.promptProfile,
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

  /**
   * Fold the `plan/mode` events of one session log ("last event wins").
   * @returns the folded active flag, or null when the log carries no plan/mode
   *   event at all (unknown, not "inactive").
   */
  function foldPlanMode(session) {
    try {
      const events = typeof session.ownEvents === 'function'
        ? session.ownEvents()
        : (Array.isArray(session.events) ? session.events : null)
      if (!Array.isArray(events)) return null
      let active = null
      for (const e of events) {
        if (e && e.type === 'plan/mode') active = !!(e.data && e.data.active)
      }
      return active
    } catch (e) { return null }
  }

  function planActive(agent) {
    // Fold the plan/mode stream the same way dsh-plan-mode does ("last event
    // wins"), instead of reading the planMode service: the service lives
    // inside the preset's plan-mode isolate realm, which is not reachable
    // from this standing-scope row. The fold lives in planStates (populated
    // by the session/event listener). A session whose plan/mode events
    // happened before this plugin instance mounted (a reopened/resumed
    // session) is folded once from the session log, so a plan session keeps
    // planning on the plan tier instead of silently dropping to the cheap
    // tier until the next flip.
    try {
      const session = agent && agent.session
      if (!session) return false
      if (planStates.has(session)) return planStates.get(session)
      const folded = foldPlanMode(session)
      if (folded !== null) {
        // A durable log is folded once (ownEvents is immutable history); a
        // mutable events array (older hosts, mocks) is re-folded per read.
        if (typeof session.ownEvents === 'function') planStates.set(session, folded)
        return folded
      }
      return false
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
    // Smart mode: the Main Agent always works on the planning/architecture
    // tier (main in the three-tier layout, strong otherwise), regardless of
    // plan state, so its provider-side KV cache stays continuous. Escalation
    // still outranks that.
    if (agent && !isChildAgent(agent) && effectiveMode(agent) === 'smart') {
      if (isEscalated(agent)) return activeTierOrder(state.threeTiers)[0]
      return planTierName()
    }
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

  /** The weakest tier of the active layout: where the guard and effort raises apply. */
  function weakTierName() {
    const order = activeTierOrder(state.threeTiers)
    return order[order.length - 1]
  }

  /** The tier one route belongs to, or null for a route outside the tier registry. */
  function tierNameOfRoute(route) {
    if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return null
    // Weakest first: when two tiers share one provider/model (strong and cheap
    // configured alike), the guard must treat the route as the weaker one.
    const order = activeTierOrder(state.threeTiers)
    for (let i = order.length - 1; i >= 0; i--) {
      const tier = state.tiers.get(order[i])
      if (tier && tier.provider === route.provider && tier.model === route.model) return order[i]
    }
    const all = state.tiers.snapshot()
    for (const name of order) {
      const tier = all[name]
      if (tier && tier.provider === route.provider && tier.model === route.model) return name
    }
    return null
  }

  /**
   * The route the agent's next request would carry, without mutating any
   * routing state (the guard must classify a child by what it would actually
   * send, even before its first request is routed).
   */
  function currentRouteOf(agent) {
    try {
      const header = headerConfigOf(agent && agent.session)
      if (header && typeof header.provider === 'string' && typeof header.model === 'string') {
        return { provider: header.provider, model: header.model, reasoningEffort: header.reasoningEffort }
      }
    } catch (e) { /* unreadable header */ }
    try {
      const options = agent && agent.options
      if (options && typeof options.provider === 'string' && typeof options.model === 'string') {
        return { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort }
      }
    } catch (e) { /* unreadable options */ }
    return null
  }

  /**
   * Consume the explicit route a caller announced before spawning one child.
   * Only an entry of the same parent whose route matches the seed qualifies,
   * so a forgotten entry can never pin an unrelated child.
   * @returns the tier name, or null.
   */
  function takePendingPin(agent, seed) {
    const now = Date.now()
    for (let i = pendingChildPins.length - 1; i >= 0; i--) {
      if (now - pendingChildPins[i].at > PENDING_PIN_TTL_MS) pendingChildPins.splice(i, 1)
    }
    let parentId = null
    try { parentId = agent.session && agent.session.header && agent.session.header.parentSession } catch (e) {}
    if (!parentId || !seed) return null
    for (let i = pendingChildPins.length - 1; i >= 0; i--) {
      const pin = pendingChildPins[i]
      if (pin.parentId !== parentId) continue
      if (seed.provider !== pin.provider || seed.model !== pin.model) continue
      pendingChildPins.splice(i, 1)
      return pin.tierName
    }
    return null
  }

  /** Announce one explicit child route until the child's first request claims it. */
  function announceChildPin(parent, route, tierName) {
    let parentId = null
    try { parentId = parent && parent.session && parent.session.id } catch (e) {}
    if (!parentId || !route) return
    while (pendingChildPins.length >= PENDING_PIN_MAX) pendingChildPins.shift()
    pendingChildPins.push({ parentId: String(parentId), provider: route.provider, model: route.model, tierName: tierName, at: Date.now() })
  }

  /**
   * Drop an announcement whose spawn never produced a child (a failed
   * `startActivation` would otherwise leave a pin for an unrelated child of
   * the same parent to claim).
   */
  function withdrawChildPin(parent, route) {
    let parentId = null
    try { parentId = parent && parent.session && parent.session.id } catch (e) {}
    if (!parentId || !route) return
    for (let i = pendingChildPins.length - 1; i >= 0; i--) {
      const pin = pendingChildPins[i]
      if (pin.parentId === String(parentId) && pin.provider === route.provider && pin.model === route.model) pendingChildPins.splice(i, 1)
    }
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
    if (!baseline) baseline = strongPrimary()
    if (baseline) sessionBaselines.set(agent, baseline)
    return baseline
  }

  function tierOf(tierName) { return state.tiers.get(tierName) || state.tiers.get('cheap') }

  /**
   * The ordered fallback chain of one tier: the configured entries only. Tier
   * models come exclusively from the plugin config - the DSH session picker
   * is never consulted for routing.
   */
  function chainFor(tierName) {
    const tier = tierOf(tierName)
    return attemptChain(null, Array.isArray(tier.fallback) ? tier.fallback : [])
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

  // ---- TurboQuant cache (smart mode) --------------------------------------
  // One cache per project root: the workspace root of the session that owns
  // the turn. Caches are bounded (CACHE_MAX_PROJECTS); the oldest one is
  // disposed when a new project root shows up.
  const CACHE_MAX_PROJECTS = 3
  // The turn's working directory seen on the last user message. It is not the
  // process cwd: until a session message arrives nothing about the project is
  // known, and writing the cache into the install directory would be wrong.
  let wsCwd
  // The session that owns the cache: its sandbox policy decides whether the
  // cache file may be written, and its workspace root contains the cache.
  let lastSession = null
  const caches = new Map()
  // Import in flight per project root: a mutation must not race the load
  // (importState replaces the whole index, so an early upsert would be lost).
  const cacheLoads = new Map()

  /**
   * The workspace root of the session that owns the turn, when it is known.
   * Path resolution (evidence reads, the minimal fs tools) uses this so a
   * relative path never resolves against the host process directory.
   */
  function sessionRoot() {
    try {
      const cwd = lastSession && lastSession.header && lastSession.header.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch (e) { /* unreadable session header */ }
    return typeof wsCwd === 'string' && wsCwd.length > 0 ? wsCwd : undefined
  }

  /** The project root the current cache belongs to. */
  function cacheRoot() {
    return sessionRoot() || process.cwd()
  }

  async function ensureVecCache() {
    const root = cacheRoot()
    const existing = caches.get(root)
    if (existing) {
      const pending = cacheLoads.get(root)
      if (pending) await pending
      return existing
    }
    const cache = createVecCache({ fs: services.fs, seams, cwd: root, sandboxPolicy: services.sandboxPolicy, getSession: () => lastSession })
    caches.set(root, cache)
    const load = cache.load().catch(() => {})
    cacheLoads.set(root, load)
    try {
      await load
    } finally {
      if (cacheLoads.get(root) === load) cacheLoads.delete(root)
    }
    // Bound the registry: dispose the oldest project cache.
    while (caches.size > CACHE_MAX_PROJECTS) {
      const oldestKey = caches.keys().next().value
      if (oldestKey === undefined) break
      const oldest = caches.get(oldestKey)
      try {
        if (oldest && typeof oldest.dispose === 'function') {
          const pending = oldest.dispose()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        }
      } catch (e) { /* the cache is dropped anyway */ }
      caches.delete(oldestKey)
      cacheLoads.delete(oldestKey)
    }
    return cache
  }

  function vecCacheStats() {
    const root = cacheRoot()
    const cache = caches.get(root)
    if (!cache) return null
    const st = cache.stats()
    return {
      project: root,
      entries: st.entries,
      bytes: st.bytes,
      dim: st.dim,
      snippets: st.snippets,
      digests: st.digests,
      stages: st.stages,
      persistent: cache.persistent,
    }
  }

  // ---- decision model (Jev / System One / OpenRouter Decisions) ------------
  let decisionClient = null
  let decisionClientSig = ''
  function ensureDecisionClient() {
    const sig = [state.decisionModel, state.decisionBaseUrl, state.decisionPath, state.decisionApiKey, state.decisionApproveAt, state.decisionBlockAt, state.decisionTimeoutMs].join('|')
    if (!decisionClient || decisionClientSig !== sig) {
      decisionClient = createDecisionClient({
        model: state.decisionModel,
        baseUrl: state.decisionBaseUrl || undefined,
        path: state.decisionPath || '/api/alpha/decisions',
        apiKey: state.decisionApiKey,
        approveAt: state.decisionApproveAt,
        blockAt: state.decisionBlockAt,
        timeoutMs: state.decisionTimeoutMs,
        fetchImpl: globalThis.fetch,
      })
      decisionClientSig = sig
    }
    return decisionClient
  }

  function decisionStageOn(stage) {
    // One implementation of the stage rule (core), plus the configuration
    // guard: selecting stages without a model enables nothing.
    return !!state.decisionModel && isDecisionStageEnabled(state.decisionStages, stage)
  }

  /**
   * One decision-model consultation. Returns null when the stage is off, no
   * model is configured, the per-turn budget is spent, or the call failed —
   * the caller then keeps its deterministic behavior. Budget is per agent per
   * user turn (reset on agent/inbox/inserted), like the advisor budget.
   */
  async function askDecision(agent, stage, questions, extraState, signal) {
    if (!decisionStageOn(stage) || !agent) return null
    const payload = buildDecisionState(Object.assign({ mode: effectiveMode(agent), planActive: planActive(agent), policy: state.subagentPolicy }, extraState))
    const client = ensureDecisionClient()
    // A replayed answer costs nothing: it is served from the response cache
    // and does not consume the per-turn budget (the budget bounds real calls).
    const used = decisionTurnCalls.get(agent) || 0
    if (used >= state.decisionBudgetPerTurn) {
      const replay = typeof client.peek === 'function' ? client.peek(questions, payload) : null
      if (replay) {
        diag.decisionHits = diag.decisionHits + 1
        diag.lastDecision = 'stage=' + stage + ' -> ' + replay.outcome + ' (replay, budget spent)'
        return replay
      }
      diag.decisionBudgetDenies = diag.decisionBudgetDenies + 1
      diag.lastDecision = 'stage=' + stage + ' budget exhausted (' + used + '/' + state.decisionBudgetPerTurn + ')'
      return null
    }
    diag.decisionCalls = diag.decisionCalls + 1
    try {
      const out = await client.ask(questions, payload, { signal })
      if (out.cached) diag.decisionHits = diag.decisionHits + 1
      else decisionTurnCalls.set(agent, used + 1)
      if (!out.ok) {
        diag.decisionErrors = diag.decisionErrors + 1
        diag.lastDecision = 'stage=' + stage + ' error: ' + out.reason
        return null
      }
      diag.lastDecision = 'stage=' + stage + ' -> ' + out.outcome
      return out
    } catch (e) {
      decisionTurnCalls.set(agent, used + 1)
      diag.decisionErrors = diag.decisionErrors + 1
      diag.lastDecision = 'stage=' + stage + ' threw: ' + String(e && e.message || e)
      return null
    }
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
      // Say which ceiling was hit: no declared level above the current one is
      // not the same as "already at max" (a model may declare only off/high).
      const detail = declared && declared.length
        ? 'the model ' + cheap.provider + '/' + cheap.model + ' declares only: ' + declared.join(', ')
        : 'no higher level is configured'
      diag.lastEffort = 'effort raise blocked: cheap effort stays ' + current + ' for ' + agentIdentity(agent) + ' (' + reason + '); ' + detail
      return { raised: false, effort: current, message: 'Cheap tier effort stays ' + current + '; ' + detail + '.' }
    }
    cheapEfforts.set(agent, { effort: next, until: Date.now() + state.effortTtlMs })
    diag.effortRaises = diag.effortRaises + 1
    diag.lastEffort = '#' + diag.effortRaises + ' cheap effort ' + current + ' -> ' + next + ' (' + reason + ') for ' + agentIdentity(agent)
    return { raised: true, effort: next, message: 'Cheap tier effort raised to ' + next + ' for this session (TTL ' + Math.round(state.effortTtlMs / 1000) + 's).' }
  }

  /** The strong route as a standalone target: always the explicit config pair. */
  function strongPrimary() {
    const strong = state.tiers.get('strong')
    return { provider: strong.provider, model: strong.model, reasoningEffort: strong.reasoningEffort }
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
    return 'configured as ' + tierLabel(state.tiers.get('strong'))
  }

  function effectiveTarget(agent, tierName) {
    const tier = tierOf(tierName)
    const fallback = activeFallbackTarget(agent, tierName)
    if (fallback) return { tierName: tierName, provider: fallback.provider, model: fallback.model, reasoningEffort: fallback.reasoningEffort }
    if (tierName !== 'cheap') {
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

  /**
   * Normalize a *stored* per-kind policy. Unlike an explicit `/tier subagent`
   * command (which refuses a policy that cannot apply right now), a stored
   * value is kept as long as it is meaningful: `main` in the two-tier layout
   * stays configured and simply has no effect until the layout is switched,
   * instead of being erased by the next persist.
   */
  function loadKindPolicy(kind, policy) {
    if (typeof policy !== 'string' || SUBAGENT_POLICIES.indexOf(policy) === -1) return ''
    if (kind === 'spawn' && policy === 'caller') return ''
    return policy
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

  /**
   * The single routing decision used by every seam: which call config this
   * agent's next request should carry. Returns a target or null (seed/baseline
   * preserved). Async because the effort is fitted to the model's declared
   * capabilities before the request leaves.
   */
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
      // The caller announced the child's tier before spawning it: claim that
      // announcement here, because the child's first request can reach this
      // waterfall before `childTiers.set()` in the caller resumes.
      if (!childTiers.has(agent) && !childKeepSeed.has(agent)) {
        const claimed = takePendingPin(agent, seedConfig)
        if (claimed) childTiers.set(agent, claimed)
      }
      const policy = policyFor(agent)
      const parentRoute = policy === 'caller' || policy === 'capped' ? parentRouteOf(agent) : null
      const source = childRouteSource({
        pinned: childTiers.has(agent),
        escalated: isEscalated(agent),
        keepSeed: childKeepSeed.has(agent),
        explicit: childIsExplicit(agent, seedConfig),
        forceTier: state.forceTierOnExplicitModel,
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
      // `capped` with an unreachable parent has no route to copy: the cap
      // itself is the ceiling, so the child runs on the cap tier instead of
      // inheriting a planning tier above it.
      if (source === 'tier' && policy === 'capped' && !parentRoute) {
        return reconcileTarget(effectiveTarget(agent, state.threeTiers ? 'main' : 'cheap'))
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
  async function runConsult(kind, input, signal, agent) {
    if (decisionStageOn('consult') && agent) {
      const focus = input.question || input.focus || ''
      const q = buildConsultQuestion({ question: focus, tier: kind })
      const d = await askDecision(agent, 'consult', q, { question: focus, focus: input.focus, tier: kind }, signal)
      if (d && d.outcome === 'block') {
        diag.decisionSkips = diag.decisionSkips + 1
        diag.lastDecision = 'consult ' + kind + ' skipped: decision model judged the question answerable on the current tier'
        return { advice: 'Consultation skipped by the decision model: the query was judged answerable on the current tier without consulting ' + kind + '.', ok: true, skipped: true, route: null }
      }
    }
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
    const weak = weakTierName()
    if (effectiveMode(agent) === 'off' || delegatedMain(agent)) {
      try {
        const baseline = captureBaseline(agent)
        const weakTier = state.tiers.get(weak)
        if (baseline && baseline.provider === weakTier.provider && baseline.model === weakTier.model) return weak
      } catch (e) {}
      return 'strong'
    }
    // A child could be executing on any of three routes: the one its current
    // step actually carries (the tool call came from that model, even when a
    // waterfall resolve failed and the seed was used), the tier recorded at
    // spawn (the window before the first routed request), and the tier the
    // policy would pick. The guard takes the WEAKEST of them: a stronger
    // intent must never vouch for a step that may run on the weak tier, and an
    // unknown route fails safe to the weak tier. Treating such a child as
    // "strong" disabled the guard for the agent that writes code on the cheap
    // model.
    if (isChildAgent(agent)) {
      const order = activeTierOrder(state.threeTiers)
      const recorded = childRouteTiers.get(agent)
      const recordedTier = typeof recorded === 'string' ? recorded : tierNameOfRoute(recorded)
      let picked = null
      for (const candidate of [tierNameOfRoute(currentRouteOf(agent)), recordedTier, tierNameFor(agent)]) {
        const rank = candidate ? order.indexOf(candidate) : -1
        if (rank > (picked === null ? -1 : picked.rank)) picked = { tier: candidate, rank: rank }
      }
      return picked ? picked.tier : weak
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
    const strong = state.tiers.get('strong')
    const main = state.tiers.get('main')
    const cheap = state.tiers.get('cheap')
    const reviewer = consultAttempts('reviewer')[0]
    const implementers = [{ label: 'cheap tier', provider: cheap.provider, model: cheap.model }]
    if (state.threeTiers) implementers.push({ label: 'main tier', provider: main.provider, model: main.model })
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
    const sidekickRouteText = (stage) => {
      const r = state.sidekick[stage]
      return r ? r.provider + '/' + r.model + (r.reasoningEffort ? ' (' + r.reasoningEffort + ')' : '') : 'cheap default'
    }
    const vc = vecCacheStats()
    const advisorCalls = agent ? (advisorTurnCalls.get(agent) || 0) : 0
    // Show the smart line only when smart actually drives this agent's
    // routing: a per-session override (e.g. auto via /tier plan) hides it.
    const smartActive = (agent ? effectiveMode(agent) : state.mode) === 'smart'
    const smartLine = smartActive
      ? '  smart: main agent pinned to ' + planTierName() + ' tier; effective route now: ' + tierLabel(effectiveTarget(agent, planTierName()))
      : ''
    const decisionLine = state.decisionModel
      ? '  decision model: ' + state.decisionModel + ' @ ' + (state.decisionBaseUrl || 'https://openrouter.ai') + state.decisionPath + '; stages: ' + (state.decisionStages.length ? state.decisionStages.join(', ') : 'none') + '; catalog: ' + (state.decisionBaseUrl || 'https://openrouter.ai') + state.decisionCatalogPath + (state.decisionCatalogQuery ? '?' + state.decisionCatalogQuery : '') + '; approve@' + state.decisionApproveAt + ' block@' + state.decisionBlockAt + ' budget=' + state.decisionBudgetPerTurn + '/turn; calls=' + diag.decisionCalls + ' hits=' + diag.decisionHits + ' errors=' + diag.decisionErrors + ' skips=' + diag.decisionSkips + ' budgetDenies=' + diag.decisionBudgetDenies
      : '  decision model: off (deterministic policy is the fallback; set decisionModel + decisionStages to enable)'
    return [
      'Tiered model routing',
      '  prompt mode: ' + promptMode + ' (standard = full guidance in the system prompt; pi = minimal prompt, heavy guidance on demand)',
      '  mode: global=' + state.mode + ', this session=' + (agent ? (sessionModes.has(agent) ? sessionModes.get(agent) : state.mode) : 'n/a') + ' (per-session via /tier strong|main|cheap|auto|delegated|off|smart; escalate: ' + state.escalateThreshold + ' errors / ' + Math.round(state.escalateWindowMs / 1000) + 's window -> ' + Math.round(state.escalateTtlMs / 1000) + 's strong)',
      smartLine,
      '  sidekick (smart mode): explore -> ' + sidekickRouteText('explore') + '; implement -> ' + sidekickRouteText('implement') + '; fix -> ' + sidekickRouteText('fix'),
      '  advisor budget: max=' + state.advisorMaxCallsPerTurn + '/turn, confirmTimeout=' + state.advisorConfirmTimeoutSec + 's, thisTurn=' + advisorCalls + ', denied=' + diag.advisorBudgetDenies + '; forceTierOnExplicitModel=' + (state.forceTierOnExplicitModel ? 'on' : 'off'),
      vc ? '  turbovec cache: snippets=' + vc.snippets + ', digests=' + vc.digests + ' (' + vc.entries + ' entries, ' + vc.bytes + ' B, 4-bit, d=' + vc.dim + ', digestHits=' + diag.digestHits + ', ' + (vc.persistent ? 'persisted on disk' : 'in-memory only') + ', project=' + vc.project + ')' : '  turbovec cache: not used yet',
      '  layout: ' + (state.threeTiers ? 'three tiers (strong = escalation, main = plan mode, cheap = execution)' : 'two tiers (strong = plan mode, cheap = execution); /tier layout three enables main'),
      '  strong: ' + tierLabel(strong) + '; fallback: ' + chainText({ fallback: chainFor('strong') }),
      '  main:   ' + tierLabel(main) + '; fallback: ' + chainText({ fallback: chainFor('main') }) + (state.threeTiers ? '' : ' (inactive)'),
      '  cheap:  ' + tierLabel(cheap) + '; fallback: ' + chainText({ fallback: chainFor('cheap') }),
      '  roles: ' + (state.rolesEnabled ? 'on' : 'off (advisor and reviewer use the strong route; /tier roles on enables their own routes)'),
      roleLine('advisor'),
      roleLine('reviewer'),
      reviewLine,
      driftLine,
      decisionLine,
      '  fallback TTL: ' + Math.round(state.fallbackTtlMs / 1000) + 's; effort TTL: ' + Math.round(state.effortTtlMs / 1000) + 's',
      '  config persisted: ' + (bridge.readable ? 'yes (host entry "' + HOST_SETTINGS_NS + '"' + (bridge.writable ? ', writable' : ', read-only') + ')' : 'no (settings service unavailable, in-memory only)'),
      '  subagents: ' + state.subagentPolicy + ' (spawn: ' + (state.spawnPolicy || 'default') + ', fork: ' + (state.forkPolicy || 'default') + ')',
      '  subagent api: ' + (seams.subagentsActivation ? 'startActivation' : seams.subagentsLegacy ? 'legacy start' : 'unavailable') + '; providers: ' + (seams.subagentsList ? subagents.list().join(', ') : 'n/a') + '; background jobs: ' + (seams.jobsStart ? 'available' : 'unavailable'),
      '  routing seam: ' + seamMode,
      '  seams: ' + seamReport(seams),
      '  diag: requestSteps=' + diag.requestSteps + ' guardChecks=' + diag.guardChecks + ' guardDenies=' + diag.guardDenies + ' headerWrites=' + diag.headerWrites + ' inboxSeen=' + diag.inboxSeen + ' planFlips=' + diag.planFlips + ' errorsSeen=' + diag.errorsSeen + ' escalations=' + diag.escalations + ' fallbacks=' + diag.fallbacks + ' effortRaises=' + diag.effortRaises + ' decisionCalls=' + diag.decisionCalls + ' decisionHits=' + diag.decisionHits + ' decisionErrors=' + diag.decisionErrors + ' decisionSkips=' + diag.decisionSkips + ' decisionBudgetDenies=' + diag.decisionBudgetDenies,
      diag.lastRouting ? '  lastRouting: ' + diag.lastRouting : '',
      diag.lastGuard ? '  lastGuard: ' + diag.lastGuard : '',
      diag.lastGuardError ? '  lastGuardError: ' + diag.lastGuardError : '',
      diag.lastHeader ? '  lastHeader: ' + diag.lastHeader : '',
      diag.lastError ? '  lastError: ' + diag.lastError : '',
      diag.lastEscalation ? '  lastEscalation: ' + diag.lastEscalation : '',
      diag.lastFallback ? '  lastFallback: ' + diag.lastFallback : '',
      diag.lastEffort ? '  lastEffort: ' + diag.lastEffort : '',
      diag.lastDecision ? '  lastDecision: ' + diag.lastDecision : '',
      '  plan gate: explore >= ' + state.planMinExplore + ' before exit_plan_mode, advisor review ' + (state.planAdvisorGate ? 'on' : 'off') + '; denies=' + diag.planGateDenies + ' consults=' + diag.planConsults,
      diag.lastGate ? '  lastGate: ' + diag.lastGate : '',
      '  models come only from plugin config (host entry tiers; the DSH session picker is ignored)',
      '  providers: ' + availableProviders().join(', '),
    ].join('\n')
  }

  async function applyRoute(tier, persist, agent) {
    if (tier === 'smart') {
      if (agent) sessionModes.set(agent, 'smart')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) applyTarget(agent, effectiveTarget(agent, planTierName()))
      const smartMsg = agent ? ' (effective route now: ' + tierLabel(effectiveTarget(agent, planTierName())) + ')' : ''
      return { applied: tier, message: 'Smart mode on for THIS session: the Main Agent stays on the ' + planTierName() + ' tier' + smartMsg + ' and changes code only through `tier_sidekick` (explore/implement/fix). Other sessions keep their own mode.' }
    }
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
        const selected = captureBaseline(agent) || strongPrimary()
        if (selected) applyTarget(agent, selected)
      }
      return { applied: tier, message: 'This session keeps its main agent on the session-selected model; only subagents are tier-routed.' }
    }
    if (tier === 'off') {
      if (agent) sessionModes.set(agent, 'off')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) {
        const def = captureBaseline(agent) || strongPrimary()
        if (def) applyTarget(agent, def)
      }
      return { applied: tier, message: 'Routing disabled for THIS session; its model returns to the default. Other sessions are unaffected; only explicit commands and tools act here.' }
    }
    if (tier === 'main' && !state.threeTiers) return { applied: tier, message: 'The main tier is inactive: the two-tier layout is on. Enable it with /tier layout three.' }
    const target = TIER_SLOTS.indexOf(tier) !== -1 ? state.tiers.get(tier) : null
    if (!target) return { applied: tier, message: 'Unknown tier "' + tier + '". Use strong, main, cheap, auto, delegated, smart, or off.' }
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
    return { ok: true, message: 'Configured ' + tierName + ' tier: ' + tierLabel(applied) + '; fallback: ' + chainText({ fallback: chainFor(tierName) }) + '. Subagent policy: ' + state.subagentPolicy + '.' + inactive + persisted }
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
        throw new Error('unexpected argument "' + tok + '" (expected --fallback <provider> <model> <effort>)')
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
        // A fresh user turn resets the advisor budget for this agent; learn
        // the workspace cwd for the TurboQuant cache when the session shows one.
        // Only substantive user messages (with textual content) count: noise
        // or empty pings must not silently refill the per-turn advisor budget.
        let hasText = false
        try {
          if (typeof message.content === 'string') hasText = message.content.trim().length > 0
          else if (Array.isArray(message.content)) {
            hasText = message.content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)
          }
        } catch (e) {}
        if (!hasText) return
        advisorTurnCalls.delete(agent)
        decisionTurnCalls.delete(agent)
        try {
          if (typeof message.content === 'string') lastTasks.set(agent, message.content.trim())
          else if (Array.isArray(message.content)) {
            const block = message.content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
            if (block) lastTasks.set(agent, block.text.trim())
          }
        } catch (e) {}
        try {
          const cwd = agent.session && agent.session.header && agent.session.header.cwd
          if (typeof cwd === 'string' && cwd.length > 0) wsCwd = cwd
          if (agent.session) lastSession = agent.session
        } catch (e) {}
        captureBaseline(agent)
        if (delegatedMain(agent)) {
          const selected = captureBaseline(agent) || strongPrimary()
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
          const selected = captureBaseline(agent) || strongPrimary()
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
        const decision = decideErrorActions(failure, escalations.get(agent), failedTier, weakTierName(), {
          threshold: state.escalateThreshold,
          windowMs: state.escalateWindowMs,
          ttlMs: state.escalateTtlMs,
          now: Date.now(),
        })
        escalations.set(agent, decision.rec)
        if (decision.actions.indexOf('escalate') !== -1) {
          let escalate = true
          if (decisionStageOn('escalate')) {
            const dq = buildEscalationQuestion({ failure: failureText, tier: failedTier })
            const d = await askDecision(agent, 'escalate', dq, { failure: failureText, tier: failedTier }, undefined)
            // A confident "this is not a model-capability failure" blocks the
            // escalation; ambiguous answers still escalate (current behavior).
            if (d && d.outcome === 'block') escalate = false
          }
          if (!escalate) {
            // Keep the record counting (until = 0) instead of active-TTL:
            // the blocked escalation must not pin the session to strong.
            escalations.set(agent, { ...decision.rec, until: 0 })
            diag.lastEscalation = '#' + diag.errorsSeen + ' escalation blocked by decision model (' + agentIdentity(agent) + ') after ' + decision.rec.count + ' errors'
          } else {
            diag.escalations = diag.escalations + 1
            diag.lastEscalation = '#' + diag.escalations + ' escalated ' + agentIdentity(agent) + ' for ' + Math.round(state.escalateTtlMs / 1000) + 's after ' + decision.rec.count + ' errors'
            applyTarget(agent, effectiveTarget(agent, 'strong'))
          }
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
        if (effectiveMode(exec.agent) === 'smart' && !isChildAgent(exec.agent) && SMART_MAIN_BLOCKED_TOOLS.includes(exec.name)) {
          diag.guardDenies = diag.guardDenies + 1
          diag.lastGuard = 'check' + checkNo + ': smart-main DENIED (' + agentIdentity(exec.agent) + ') ' + exec.name
          return {
            kind: 'deny',
            reason: 'Session is in smart mode: the Main Agent plans and reviews while keeping its context clean. ' + (promptMode === 'pi' ? 'Delegate code/test changes via `tier_worker` (cheap tier).' : 'Delegate code/test/lint changes to `tier_sidekick` with stage "implement" or "fix".'),
          }
        }
        const tier = effectiveExecutionTier(exec.agent)
        const hit = isHighImpact(exec.name, exec.arguments)
        const decision = decideGuardAction(tier, hit, weakTierName())
        if (decision.action === 'allow') {
          diag.lastGuard = 'check' + checkNo + ': tier=' + tier + (hit ? ' allow despite hit' : ' allow') + ' (' + agentIdentity(exec.agent) + ')'
          return next()
        }
        const allowed = await decisionGuardAllow(exec, tier)
        if (allowed) {
          diag.lastGuard = 'check' + checkNo + ': DENIED but ALLOWED by decision model (' + agentIdentity(exec.agent) + ') ' + exec.name
          return next()
        }
        diag.guardDenies = diag.guardDenies + 1
        diag.lastGuard = 'check' + checkNo + ': DENIED (' + agentIdentity(exec.agent) + ') ' + String(decision.reason).slice(0, 60)
        const raised = await raiseCheapEffort(exec.agent, 'high-impact guard deny')
        const cheap = state.tiers.get('cheap')
        return {
          kind: 'deny',
          reason: decision.reason + ' — this high-impact action would execute on the cheap tier (' + tierLabel(cheap) + '). ' + (promptMode === 'pi' ? 'Escalate first: run this action through tier_worker with tier "strong", then report its result.' : 'Escalate first: call tier_route with tier "strong" (or /tier strong), then re-issue the action.') + (raised.raised ? ' Cheap tier effort raised to ' + raised.effort + '.' : ''),
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
    const review = await runConsult('advisor', { question: 'Is this plan ready to present for approval? Check it against the code evidence and name what must change first.', evidence: planTextOf(exec.arguments) }, exec.signal, agent)
    if (review.skipped) {
      diag.lastGate = 'advisor review skipped by decision model (' + agentIdentity(agent) + ')'
      return null
    }
    if (!review.ok) {
      diag.lastGate = 'advisor unavailable: plan presented without advisor review (' + agentIdentity(agent) + ')'
      return null
    }
    diag.lastGate = 'advisor review denied the plan once (' + agentIdentity(agent) + ')'
    return { kind: 'deny', reason: 'Advisor review before presenting the plan:\n' + review.advice + '\nRevise the plan to address this, then call exit_plan_mode again.' }
  }

  /**
   * Second-stage decision-model classification of a guard denial. Only an
   * explicit 'approve' of every noul question may override a deterministic
   * deny; anything else (block/review/unknown/error/no-budget) keeps the deny
   * — the deterministic pattern stays authoritative and we fail closed.
   */
  async function decisionGuardAllow(exec, tier) {
    if (!decisionStageOn('guard')) return false
    const questions = buildGuardQuestions({
      commands: exec.arguments,
      project: sessionRoot(),
      task: lastTasks.get(exec.agent),
    })
    const d = await askDecision(exec.agent, 'guard', questions, { tool: exec.name, tier, commands: exec.arguments }, exec.signal)
    return !!(d && d.outcome === 'approve')
  }

  // Minimal (pi) prompt mode declares only tier_worker: every other tier_* tool
  // adds its definition to each request, and in the minimal preset the model
  // reaches the full toolset through tier_worker with agentPreset "tiered".
  const fullToolset = promptMode !== 'pi'

  if (seams.tools) {
    // The standard toolset only: in pi mode every tool definition is passed
    // over for registration, so building them first would only add startup
    // work (and a second place where the pi surface could drift).
    if (fullToolset) {
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
        description: 'Consult the advisor model (' + consultRouteText('advisor') + ') on one hard decision before committing to an approach. Use when requirements stay ambiguous after inspection, the work implicates architecture/security/data integrity/compatibility, several root causes remain, two evidence-based attempts failed, or a high-cost judgement is needed. Provide ONE decision question plus evidence already gathered. Returns guidance to apply; implementation stays on the current model. Per-turn budget: ' + state.advisorMaxCallsPerTurn + ' calls without asking; the next one asks for confirmation (timeout ' + state.advisorConfirmTimeoutSec + 's).',
        parameters: {
          question: { type: 'string', required: true, description: 'One explicit decision question, e.g. "Can the proposed cache policy expose stale authorization data?"' },
          evidence: { type: 'string', description: 'Relevant facts already collected: file paths, call graphs, outputs, errors, constraints.' },
          paths: { type: 'json', description: 'Optional array of file paths to attach as evidence.' },
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
              risks: { type: 'array', items: { type: 'string' } },
              nextSteps: { type: 'array', items: { type: 'string' } },
              acceptanceChecks: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const head = value.ok ? 'Advisor (' + value.provider + '/' + value.model + '):' : 'Advisor call failed (' + value.provider + '/' + value.model + '):'
            return [{ type: 'text', text: head + '\n' + value.advice }]
          },
        },
        async execute(args, exec) {
          const calls = advisorTurnCalls.get(exec.agent) || 0
          const budget = decideAdvisorBudget(calls, state.advisorMaxCallsPerTurn, state.advisorConfirmTimeoutSec)
          const denial = () => {
            diag.advisorBudgetDenies = diag.advisorBudgetDenies + 1
            const target = consultAttempts('advisor')[0] || { provider: '?', model: '?' }
            return {
              advice: 'Advisor call denied: per-turn limit (' + state.advisorMaxCallsPerTurn + ') reached and no approval was given within ' + state.advisorConfirmTimeoutSec + 's. Proceed with the evidence already gathered.',
              ok: false,
              tier: 'strong',
              provider: target.provider,
              model: target.model,
            }
          }
          if (budget.action !== 'allow') {
            if (budget.action === 'ask' && seams.approvalRequest && !isChildAgent(exec.agent)) {
              let outcome = 'unavailable'
              try {
                const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(budget.timeoutMs)].filter(Boolean))
                outcome = await services.approval.request({
                  agent: exec.agent,
                  toolName: 'tier_advisor',
                  reason: 'Advisor already called ' + calls + ' time(s) this turn. Allow another call?',
                  signal,
                })
              } catch (e) { outcome = 'unavailable' }
              if (outcome !== 'allowed-once') return denial()
            } else {
              return denial()
            }
          }
          advisorTurnCalls.set(exec.agent, calls + 1)
          let input = args
          let extra = []
          const cache = await ensureVecCache()
          if (Array.isArray(args.paths) && args.paths.length > 0) {
            const files = await readEvidencePaths(args.paths, { fs: services.fs, seams, cwd: sessionRoot() })
            for (const f of files) extra.push('File ' + f.path + ':\n' + f.text)
          }
          const hits = cache.search(String(args.question || ''), { k: 3, minScore: 0.15 })
          if (hits.length > 0) {
            extra.push('Known cached snippets:\n' + hits.map((h) => '- ' + h.path + (h.lines ? ':' + h.lines : '') + ' ' + String(h.snippet || '').slice(0, 200)).join('\n'))
          }
          if (extra.length > 0) {
            input = { ...args, evidence: [args.evidence, extra.join('\n\n')].filter(Boolean).join('\n\n') }
          }
          const r = await runConsult('advisor', input, exec.signal, exec.agent)
          if (r.skipped) {
            return { advice: r.advice, ok: true, tier: 'decision', provider: 'decision-model', model: state.decisionModel || 'decision-model' }
          }
          return {
            advice: r.advice,
            ok: r.ok,
            tier: 'strong',
            provider: r.route.provider,
            model: r.route.model,
            ...(r.risks ? { risks: r.risks } : {}),
            ...(r.nextSteps ? { nextSteps: r.nextSteps } : {}),
            ...(r.acceptanceChecks ? { acceptanceChecks: r.acceptanceChecks } : {}),
          }
        },
      })
      safeRegister('tier_advisor tool', () => tools.register(advisorTool))

      const reviewTool = defineTool({
        name: 'tier_review',
        description: 'Independent review (' + consultRouteText('reviewer') + ') before declaring a task complete or merging high-risk changes. Pass the exact change set, validation commands and results, and the review focus. Returns a verdict and issues ranked by severity.',
        parameters: {
          focus: { type: 'string', required: true, description: 'What is being reviewed: the change set, files, and the risk being checked.' },
          evidence: { type: 'string', description: 'Validation results, diffs, command outputs, acceptance criteria.' },
          paths: { type: 'json', description: 'Optional array of file paths to attach as evidence.' },
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
              issues: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const head = value.ok ? 'Review (' + value.provider + '/' + value.model + '): ' + value.verdict : 'Review call failed (' + value.provider + '/' + value.model + '):'
            return [{ type: 'text', text: head + '\n' + value.review }]
          },
        },
        async execute(args, exec) {
          let input = args
          let extra = []
          const cache = await ensureVecCache()
          if (Array.isArray(args.paths) && args.paths.length > 0) {
            const files = await readEvidencePaths(args.paths, { fs: services.fs, seams, cwd: sessionRoot() })
            for (const f of files) extra.push('File ' + f.path + ':\n' + f.text)
          }
          const hits = cache.search(String(args.focus || ''), { k: 3, minScore: 0.15 })
          if (hits.length > 0) {
            extra.push('Known cached snippets:\n' + hits.map((h) => '- ' + h.path + (h.lines ? ':' + h.lines : '') + ' ' + String(h.snippet || '').slice(0, 200)).join('\n'))
          }
          if (extra.length > 0) {
            input = { ...args, evidence: [args.evidence, extra.join('\n\n')].filter(Boolean).join('\n\n') }
          }
          const r = await runConsult('review', input, exec.signal, exec.agent)
          if (r.skipped) {
            return { verdict: 'SKIPPED', review: r.review, ok: true, tier: 'decision', provider: 'decision-model', model: state.decisionModel || 'decision-model' }
          }
          return {
            verdict: r.verdict,
            review: r.review,
            ok: r.ok,
            tier: 'strong',
            provider: r.route.provider,
            model: r.route.model,
            ...(r.issues ? { issues: r.issues } : {}),
          }
        },
      })
      safeRegister('tier_review tool', () => tools.register(reviewTool))

      const routeTool = defineTool({
        name: 'tier_route',
        description: 'Set the routing mode for THIS session only (other sessions keep their own mode). strong = ' + tierLabel(state.tiers.get('strong')) + ' for hard stretches (architecture, debugging, design); cheap = ' + tierLabel(state.tiers.get('cheap')) + ' for routine implementation; auto = strong while plan mode is active and cheap while executing; delegated = keep the main agent on the session-selected model and route only subagents; smart = the main agent plans/reviews on the plan tier and delegates file edits to tier_sidekick; off = disable per-step routing for this session and return it to its default model.',
        parameters: {
          tier: { type: 'string', required: true, enum: ['strong', 'main', 'cheap', 'auto', 'delegated', 'smart', 'off'], description: 'Routing tier or mode to apply to this session. main is active only in the three-tier layout; smart pins the main agent to the plan tier under delegates file edits to sidekicks.' },
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
        description: 'Configure which provider/model/effort backs each tier (strong, main, cheap), their fallback chains, and the subagent policy. Any registered provider and model id work. Efforts are validated against the target model\'s declared reasoning efforts when metadata is available (e.g. deepseek models declare off/high/max). The configuration persists on the host profile entry (pass sessionOnly: true for a transient change); persist: true also writes the session default model.',
        parameters: {
          tier: { type: 'string', required: true, enum: ['strong', 'main', 'cheap', 'advisor', 'reviewer'], description: 'Which slot to configure: a tier (strong, main, cheap) or a consultation role (advisor, reviewer; provider/model/effort only, sharing the strong fallback chain).' },
          provider: { type: 'string', description: 'Registered provider route, e.g. "deepseek-official". Default keeps the current value.' },
          model: { type: 'string', description: 'Model id for that provider, e.g. "deepseek-v4-flash". Default keeps the current value.' },
          reasoningEffort: { type: 'string', description: 'Reasoning effort for this tier (any string; validated against the model\'s declared efforts). Default keeps the current value.' },
          fallback: { type: 'json', description: 'Optional ordered fallback chain: [{ provider, model, reasoningEffort }]. Default keeps the current chain.' },
          subagentPolicy: { type: 'string', enum: SUBAGENT_POLICIES, description: 'Optional: how subagent steps route, for both kinds unless spawnPolicy/forkPolicy overrides it. inherit = same rules as the main agent (mode and plan state; in smart mode a child runs on the cheap tier, since smart mode delegates execution); cheap, strong or main = fixed tier; caller = the parent\'s current route; capped = the parent\'s route but never above main (cheap in two tiers).' },
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
    }

    /**
     * Record one worker outcome in the TurboQuant cache: the touched files
     * become snippets of the "worker" stage, and the first touched area
     * becomes a digest card (the worker's experience). Only paths inside the
     * current project are recorded. Best-effort: never throws.
     * @param res - the settled worker result ({ output, ... }).
     * @param taskText - the task the worker ran (kept for context).
     */
    async function recordWorkerOutcome(res, taskText) {
      try {
        const output = String(res && res.output || '')
        const parsed = parseChangeReport(output, true)
        const root = normalizePath(cacheRoot())
        const kept = []
        for (const raw of parsed.touchedFiles || []) {
          const f = String(raw == null ? '' : raw).trim()
          if (!f) continue
          const norm = normalizePath(f)
          if (norm.indexOf('node_modules') !== -1) continue
          if (norm.startsWith('.git/')) continue
          if (isAbsolutePath(norm) && !isInsideRoot(norm, root)) continue
          kept.push(f)
        }
        if (kept.length === 0) return
        const cache = await ensureVecCache()
        const summary = (parsed.diffSummary || output).slice(0, 500)
        for (const f of kept) {
          cache.invalidateByPath(f)
          cache.upsert({
            id: 'change:worker:' + f,
            path: f,
            lines: '',
            snippet: summary,
            note: parsed.checks || '',
            stage: WORKER_STAGE,
          })
        }
        cache.upsertDigest({
          stage: WORKER_STAGE,
          area: kept[0],
          diffSummary: parsed.diffSummary || '',
          checks: parsed.checks || '',
          issues: '',
        })
      } catch (e) { /* the memory write is best-effort */ }
    }

    const workerTool = defineTool({
      name: 'tier_worker',
      description: 'Delegate a bounded task packet to a fresh subagent that runs on a chosen tier: cheap (configured as ' + tierLabel(state.tiers.get('cheap')) + ') for routine implementation, main (configured as ' + tierLabel(state.tiers.get('main')) + ', three-tier layout only) for the default work, or strong (configured as ' + tierLabel(state.tiers.get('strong')) + ') for hard analysis. Optional: outputSchema for a structured result, agentPreset to compose the worker from a different agent preset (spawn provider), maxDepth to cap delegation depth, background to run via the jobs service. Returns the worker\'s final output (or structured result) and stop reason.' + (promptMode === 'pi' ? ' In this minimal session it is the only delegation tool: pass agentPreset "tiered" to give the worker the full toolset (advisor, review, status, route).' : ''),
      parameters: {
        task: { type: 'string', required: true, description: 'Complete self-contained task packet for the worker: objective, in-scope/out-of-scope, constraints, expected return.' },
        tier: { type: 'string', enum: ['cheap', 'main', 'strong'], description: 'Tier the worker subagent runs on. Default cheap. main requires the three-tier layout.' },
        provider: { type: 'string', description: 'Subagent provider name. Default: the first registered provider.' },
        paths: { type: 'json', description: 'Optional array of file paths to focus memory on.' },
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
        let tierName = args.tier === 'strong' || args.tier === 'main' ? args.tier : 'cheap'
        if (!args.tier && decisionStageOn('worker')) {
          const candidates = [
            { id: 'cheap', label: 'cheap', description: 'Routine implementation: the cheapest tier for bounded mechanical work.' },
            ...(state.threeTiers ? [{ id: 'main', label: 'main', description: 'The default-work tier of the three-tier layout.' }] : []),
            { id: 'strong', label: 'strong', description: 'Hard analysis: architecture, debugging, design decisions.' },
          ]
          const d = await askDecision(exec.agent, 'worker', buildTierQuestion({ candidates, task: args.task }), { packet: String(args.task).slice(0, 400), candidates: candidates.map(function (c) { return c.id }) }, exec.signal)
          if (d && d.outcome === 'approve' && typeof d.values.tier === 'string' && TIER_SLOTS.indexOf(d.values.tier) !== -1) {
            const proposed = state.tiers.get(d.values.tier)
            if (proposed && availableProviders().indexOf(proposed.provider) !== -1) tierName = d.values.tier
          }
        }
        if (tierName === 'main' && !state.threeTiers) throw new Error('tier_worker: the main tier is inactive; enable the three-tier layout first (/tier layout three)')
        const tier = state.tiers.get(tierName)
        if (availableProviders().indexOf(tier.provider) === -1) {
          throw new Error('tier_worker: provider "' + tier.provider + '" is not registered. Registered: ' + availableProviders().join(', '))
        }
        const parent = exec.agent
        if (!parent) throw new Error('tier_worker: requires a calling agent')
        // Fit the effort to what the model declares before it leaves: the
        // child's seed is preserved for tier pins, so nothing downstream will
        // correct an undeclared level.
        const route = await reconcileTarget({ provider: tier.provider, model: tier.model, reasoningEffort: tier.reasoningEffort })
        // Announce the pin before the spawn so the child's first request
        // resolves to the chosen tier even when it races `settleRun` below.
        announceChildPin(parent, route, tierName)
        // Memory: the cached snippets and digest cards of the current project
        // that match the task. The worker sees every stage: a worker is not
        // bound to one stage of the smart-mode loop.
        const cache = await ensureVecCache()
        const taskText = String(args.task || '')
        const pathList = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : undefined
        const snippetHits = cache.search(taskText, { k: 5, minScore: 0.12, ...(pathList ? { pathFilter: pathList } : {}) })
        const cardHits = cache.search(taskText, { k: 3, minScore: 0.12, kindFilter: 'digest' })
        if (cardHits.length > 0) diag.digestHits = diag.digestHits + 1
        const memoryLines = formatMemoryBlock({ snippets: snippetHits, cards: cardHits.map((c) => formatCard(c)) })
        const promptParts = [taskText]
        if (pathList) promptParts.push('Relevant files: ' + pathList.join(', '))
        for (const line of memoryLines) promptParts.push(line)
        const promptText = promptParts.join('\n')
        const spec = {
          provider: providerName,
          label: String(args.task).slice(0, 100),
          prompt: [{ type: 'text', text: promptText }],
          parent: parent,
          // Supply the complete route at creation instead of rewriting the
          // model-selection waterfall downstream.
          agentOptions: {
            provider: route.provider,
            model: route.model,
            ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
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
          if (childAgent && childAgent !== parent) {
            childTiers.set(childAgent, tierName)
            childRouteTiers.set(childAgent, tierName)
          }
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
            provider: route.provider,
            model: route.model,
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
                  let run
                  try {
                    run = await startWorker(subagents, { ...spec, signal: controller.signal })
                  } catch (e) {
                    withdrawChildPin(parent, route)
                    throw e
                  }
                  const res = await settleRun(run)
                  await recordWorkerOutcome(res, String(args.task))
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

        let run
        try {
          run = await startWorker(subagents, spec)
        } catch (e) {
          withdrawChildPin(parent, route)
          throw e
        }
        const out = await settleRun(run)
        await recordWorkerOutcome(out, String(args.task))
        return out
      },
    })
    safeRegister('tier_worker tool', () => tools.register(workerTool))

    if (fullToolset) {
      const sidekickTool = defineTool({
        name: 'tier_sidekick',
        description: 'Delegate one stage of the smart-mode loop to a sidekick subagent: explore (returns file snippets), implement (writes code/tests/lint fixes), or fix (fixes bugs). The Main Agent in smart mode uses this instead of editing files directly. Each call spawns a fresh sidekick on the stage model (a fresh session: the context cache does not carry across calls).',
        parameters: {
          stage: { type: 'string', required: true, enum: SIDEKICK_STAGES, description: 'Which stage runs on the right side of the scheme.' },
          task: { type: 'string', required: true, description: 'What to find, write, or fix.' },
          paths: { type: 'json', description: 'Optional known files/directories to start from.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              stage: { type: 'string', required: true },
              ok: { type: 'boolean', required: true },
              output: { type: 'string', required: true },
              snippets: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string' },
                    lines: { type: 'string' },
                    snippet: { type: 'string' },
                    summary: { type: 'string' },
                  },
                },
              },
              touchedFiles: { type: 'array', items: { type: 'string' } },
              diffSummary: { type: 'string' },
              checks: { type: 'string' },
            },
          },
          render(args, value) {
            const head = 'Sidekick (' + value.stage + '): ' + (value.ok ? 'ok' : 'failed')
            return [{ type: 'text', text: head + '\n' + value.output }]
          },
        },
        async execute(args, exec) {
          const spec = sidekickSpec(args.stage)
          if (!spec) throw new Error('tier_sidekick: unknown stage "' + args.stage + '"')
          diag.sidekickCalls = diag.sidekickCalls + 1
          let route = resolveSidekickTarget(args.stage, state)
          if (!route) throw new Error('tier_sidekick: no route for stage "' + args.stage + '"')
          if (decisionStageOn('worker') && !state.sidekick[args.stage]) {
            const candidates = [
              { id: 'cheap', label: 'cheap', description: 'Routine implementation: the cheapest stage route.' },
              ...(state.threeTiers ? [{ id: 'main', label: 'main', description: 'The default-work tier of the three-tier layout.' }] : []),
              { id: 'strong', label: 'strong', description: 'Hard analysis: architecture, debugging, design decisions.' },
            ]
            const d = await askDecision(exec.agent, 'worker', buildTierQuestion({ candidates, task: args.task }), { packet: String(args.task).slice(0, 400), candidates: candidates.map(function (c) { return c.id }), sidekickStage: args.stage }, exec.signal)
            if (d && d.outcome === 'approve' && typeof d.values.tier === 'string' && TIER_SLOTS.indexOf(d.values.tier) !== -1) {
              const proposed = state.tiers.get(d.values.tier)
              if (proposed && availableProviders().indexOf(proposed.provider) !== -1) route = proposed
            }
          }
          if (availableProviders().indexOf(route.provider) === -1) {
            throw new Error('tier_sidekick: stage "' + args.stage + '" is configured with provider "' + route.provider + '", which is not registered. Set it with `/tier set sidekick-' + args.stage + ' <provider> <model> [effort]`. Registered: ' + availableProviders().join(', '))
          }
          // The stage model is seeded verbatim into the child (keepSeed), so this
          // route never passes the child's own request router: fit the effort to
          // what the model declares here or the spawn fails with
          // UNSUPPORTED_REASONING_EFFORT.
          route = await reconcileTarget(route)
          if (!subagents || (!seams.subagentsActivation && !seams.subagentsLegacy)) throw new Error('tier_sidekick: subagents service is not mounted')
          const names = seams.subagentsList ? subagents.list() : []
          const providerName = names.indexOf('spawn') !== -1 ? 'spawn' : (names.length > 0 ? names[0] : null)
          if (!providerName) throw new Error('tier_sidekick: no subagent provider registered')
          // Recorded for the guard: the child keeps this seed route, so its
          // actual tier is the class of that route, not "strong".
          const stageTier = tierNameOfRoute(route)
          const cache = await ensureVecCache()
          const taskText = String(args.task || '')
          const pathList = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : undefined
          // Snippets: wider k and path scoping when known paths are given.
          const snippetHits = cache.search(taskText, {
            k: pathList ? 8 : 5,
            minScore: 0.12,
            ...(pathList ? { pathFilter: pathList } : {}),
            kindFilter: 'snippet',
          })
          // Digest cards: the sidekick's memory for this stage (plus the
          // worker experience for implement/fix).
          const cardHits = cache.search(taskText, { k: 3, minScore: 0.12, kindFilter: 'digest', stageFilter: digestStagesFor(args.stage) })
          if (cardHits.length > 0) diag.digestHits = diag.digestHits + 1
          const cards = cardHits.map((c) => formatCard(c))
          const promptText = spec.buildUser({ task: args.task, paths: args.paths, snippets: snippetHits, cards })
          const parent = exec.agent
          if (parent && stageTier) announceChildPin(parent, route, stageTier)
          const spawnSpec = {
            provider: providerName,
            label: 'sidekick:' + args.stage,
            prompt: [{ type: 'text', text: promptText }],
            parent,
            agentOptions: {
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
            },
            signal: exec.signal,
          }
          let run
          try {
            run = await startWorker(subagents, spawnSpec)
          } catch (e) {
            withdrawChildPin(parent, route)
            throw e
          }
          let childAgent = run.localAgent || null
          if (!childAgent && run.childId && agents && seams.agentsGet) {
            try { childAgent = agents.get(run.childId) || null } catch (e) {}
          }
          if (childAgent && childAgent !== parent) {
            childKeepSeed.set(childAgent, true)
            // The guard classifies a keep-seed child by the route it was given;
            // an unknown stage model counts as the weak tier (fail safe).
            childRouteTiers.set(childAgent, stageTier || weakTierName())
          }
          let text = ''
          try {
            const result = await run.result
            if (result && Array.isArray(result.output)) {
              for (const block of result.output) {
                if (block && block.type === 'text' && typeof block.text === 'string') text += block.text + '\n'
              }
            }
          } finally {
            try { await run.dispose() } catch (e) {}
          }
          text = text.trim()
          const parsed = spec.parse(text, text.length > 0)
          if (args.stage === 'explore') {
            for (const s of parsed.snippets || []) {
              cache.upsert({ id: s.path + ':' + s.lines, path: s.path, lines: s.lines || '', snippet: s.snippet || '', note: s.summary || '', stage: 'explore' })
            }
          } else {
            for (const f of parsed.touchedFiles || []) cache.invalidateByPath(f)
            for (const f of parsed.touchedFiles || []) {
              cache.upsert({
                id: 'change:' + args.stage + ':' + f,
                path: f,
                lines: '',
                snippet: parsed.diffSummary || text.slice(0, 500),
                note: parsed.checks || '',
                stage: args.stage,
              })
              // Digest card: the sidekick's memory of this stage/area.
              cache.upsertDigest({
                stage: args.stage,
                area: f,
                diffSummary: parsed.diffSummary || '',
                checks: parsed.checks || '',
                issues: '',
              })
            }
          }
          const base = { stage: args.stage, ok: parsed.ok, output: text }
          if (args.stage === 'explore') return { ...base, snippets: parsed.snippets || [] }
          return { ...base, touchedFiles: parsed.touchedFiles || [], diffSummary: parsed.diffSummary || '', checks: parsed.checks || '' }
        },
      })
      safeRegister('tier_sidekick tool', () => tools.register(sidekickTool))
    }
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
          const r = await runConsult('advisor', { question: q }, invocation.signal, invocation.agent)
          const head = r.skipped ? 'Advisor (decision model):' : 'Advisor (' + r.route.provider + '/' + r.route.model + '):'
          return { kind: 'success', text: head + '\n' + r.advice }
        } catch (e) {
          return { kind: 'error', text: 'advisor failed: ' + String(e && e.message || e) }
        }
      },
    }))

    safeRegister('/tier command', () => commands.register({
      name: 'tier',
      description: 'Control tiered model routing',
      input: { hint: 'status | strong | main | cheap | auto | delegated | off | plan | models | layout <two|three> | roles <on|off> | gate explore <n> | gate advisor <on|off> | set <strong|main|cheap|advisor|reviewer> <provider> <model> [effort] [--fallback <p> <m> <e> ...] | effort <low|medium|high|max> | subagent <inherit|cheap|strong> | review <focus>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        const parts = raw.split(/\s+/)
        const sub = (parts[0] || 'status').toLowerCase()
        const rest = parts.slice(1)
        const arg = rest.join(' ')
        try {
          if (sub === 'status') return { kind: 'success', text: statusText(invocation.agent) }
          if (sub === 'smart') { const r = await applyRoute('smart', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'cache') {
            const what = rest[0] || 'status'
            const cache = await ensureVecCache()
            if (what === 'status') {
              const st = cache.stats()
              const stages = st.stages || {}
              const stageText = 'explore ' + (stages.explore || 0) + ', implement ' + (stages.implement || 0) + ', fix ' + (stages.fix || 0) + ', worker ' + (stages.worker || 0)
              return { kind: 'success', text: 'TurboQuant cache: snippets=' + st.snippets + ', digests=' + st.digests + ' (' + stageText + ') (' + st.entries + ' entries, ' + st.bytes + ' B, 4-bit, d=' + st.dim + ', maxEntries=' + st.maxEntries + '), digestHits=' + diag.digestHits + ', ' + (cache.persistent ? 'persisted ' + CACHE_FILE_NAME : 'in-memory only') + ', project=' + cacheRoot() }
            }
            if (what === 'invalidate') {
              const target = rest.slice(1).join(' ')
              if (!target) return { kind: 'error', text: 'usage: /tier cache invalidate <path>' }
              const n = cache.invalidateByPath(target)
              return { kind: 'success', text: 'Invalidated ' + n + ' cache entries under ' + target + '.' }
            }
            if (what === 'export') {
              const arg = rest[1]
              const isStage = arg !== undefined && (SIDEKICK_STAGES.indexOf(arg) !== -1 || arg === WORKER_STAGE)
              if (arg === undefined || arg === 'file') {
                const r = await cache.writeExport()
                if (r.ok) return { kind: 'success', text: 'Exported ' + r.entries + ' entries to ' + r.path + ' (project ' + cacheRoot() + ').' }
                return { kind: 'error', text: 'Export failed: ' + r.error }
              }
              if (arg === '--inline' || arg === 'inline' || isStage) {
                const stageArg = isStage ? arg : undefined
                let entries = cache.list({ kind: 'digest', ...(stageArg ? { stage: stageArg } : {}) })
                let digests = true
                if (!entries || entries.length === 0) {
                  digests = false
                  entries = cache.list({ kind: 'snippet' })
                }
                const total = entries.length
                const lines = []
                for (const e of entries.slice(0, 20)) {
                  const snippet = String(e.snippet || '').slice(0, 80)
                  if (digests) lines.push('• [' + String(e.stage || '') + '/' + String(e.path || '') + '] ' + snippet)
                  else lines.push('• ' + String(e.path || '') + (e.lines ? ':' + e.lines : '') + ' ' + snippet)
                }
                let text = 'Cached memory (max 20):'
                if (lines.length > 0) text += '\n' + lines.join('\n')
                if (total > lines.length) text += '\n… ' + (total - lines.length) + ' more'
                return { kind: 'success', text }
              }
              return { kind: 'error', text: 'usage: /tier cache export [file|--inline|<stage>]' }
            }
            if (what === 'gc') {
              if (!seams.fsStat) return { kind: 'error', text: 'gc unavailable: the fs stat seam is missing' }
              const check = async (path) => {
                try {
                  const target = await services.fs.resolve(path, { cwd: cacheRoot() })
                  await services.fs.stat(target)
                  return true
                } catch (e) { return false }
              }
              const r = await cache.removeStaleFiles(check)
              return { kind: 'success', text: 'Removed ' + r.removed + ' stale entries (' + r.checked + ' files checked' + (r.skipped ? ', ' + r.skipped + ' unreadable' : '') + ').' }
            }
            if (what === 'clear') {
              cache.clear()
              return { kind: 'success', text: 'TurboQuant cache cleared.' }
            }
            if (what === 'search') {
              const q = rest.slice(1).join(' ')
              if (!q) return { kind: 'error', text: 'usage: /tier cache search <query>' }
              const hits = cache.search(q, { k: 5, minScore: 0.05 })
              if (hits.length === 0) return { kind: 'success', text: 'No cached snippets matched "' + q + '".' }
              const lines = hits.map((h, i) => (i + 1) + '. ' + h.path + (h.lines ? ':' + h.lines : '') + ' [' + h.score.toFixed(3) + '] ' + String(h.snippet || '').replace(/\s+/g, ' ').slice(0, 80))
              return { kind: 'success', text: 'Top ' + hits.length + ' cached snippets for "' + q + '":\n' + lines.join('\n') }
            }
            return { kind: 'error', text: 'usage: /tier cache <status|invalidate <path>|export [file|--inline|<stage>]|gc|clear|search <query>>' }
          }
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
            } else if (what === 'advisor-limit') {
              const maxCalls = Number(rest[1])
              const timeoutSec = rest[2] !== undefined ? Number(rest[2]) : state.advisorConfirmTimeoutSec
              if (!Number.isInteger(maxCalls) || maxCalls < 0 || !Number.isFinite(timeoutSec) || timeoutSec < 0) {
                return { kind: 'error', text: 'usage: /tier gate advisor-limit <maxCalls> [timeoutSec]' }
              }
              state.advisorMaxCallsPerTurn = maxCalls
              state.advisorConfirmTimeoutSec = Math.floor(timeoutSec)
            } else {
              return { kind: 'error', text: 'usage: /tier gate explore <n> | /tier gate advisor <on|off> | /tier gate advisor-limit <maxCalls> [timeoutSec]' }
            }
            const saved = await persistTierConfig()
            return { kind: 'success', text: 'Plan gate: explore >= ' + state.planMinExplore + ' before exit_plan_mode, advisor review ' + (state.planAdvisorGate ? 'on' : 'off') + '; advisor budget max=' + state.advisorMaxCallsPerTurn + '/turn, confirmTimeout=' + state.advisorConfirmTimeoutSec + 's.' + saved }
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
            const skMatch = (rest[0] || '').match(/^sidekick-(explore|implement|fix)$/)
            if (skMatch) {
              const stage = skMatch[1]
              const usage = 'usage: /tier set sidekick-' + stage + ' <provider> <model> [effort] | reset'
              if (rest[1] === 'reset') {
                state.sidekick[stage] = null
                const saved = await persistTierConfig()
                return { kind: 'success', text: 'Sidekick ' + stage + ' route reset to the cheap default.' + saved }
              }
              const provider = rest[1]
              const model = rest[2]
              const effort = rest[3]
              if (!provider || !model) return { kind: 'error', text: usage }
              if (availableProviders().indexOf(provider) === -1) {
                return { kind: 'error', text: 'Provider "' + provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
              }
              if (effort) {
                const check = await validateEffortFor(provider, model, effort)
                if (!check.ok) return { kind: 'error', text: 'Rejected effort "' + effort + '" for ' + provider + '/' + model + ': the model declares only ' + check.available.join(', ') + '.' }
              }
              state.sidekick[stage] = { provider, model, reasoningEffort: effort || '' }
              const saved = await persistTierConfig()
              return { kind: 'success', text: 'Sidekick ' + stage + ' route set to ' + provider + '/' + model + (effort ? ' (' + effort + ')' : '') + '.' + saved }
            }
            const tier = rest[0]
            const usage = 'usage: /tier set <strong|main|cheap|advisor|reviewer> <provider> <model> [effort] [--fallback <p> <m> <e> ...] | /tier set sidekick-<explore|implement|fix> <provider> <model> [effort] | reset'
            if (TIER_SLOTS.indexOf(tier) === -1 && ROLE_KINDS.indexOf(tier) === -1) return { kind: 'error', text: usage }
            let parsed
            try {
              parsed = parseSetArgs(rest.slice(1))
            } catch (e) {
              return { kind: 'error', text: String(e && e.message || e) }
            }
            if (!parsed.provider || !parsed.model) {
              return { kind: 'error', text: usage }
            }
            const r = await applyConfigure({ tier: tier, provider: parsed.provider, model: parsed.model, reasoningEffort: parsed.effort, fallback: parsed.fallback, sessionOnly: false, persist: false }, invocation.agent)
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
            if (rest[0] === 'force-explicit') {
              const v = rest[1]
              if (v !== 'on' && v !== 'off') return { kind: 'error', text: 'usage: /tier subagent force-explicit <on|off>' }
              state.forceTierOnExplicitModel = v === 'on'
              const saved = await persistTierConfig()
              return { kind: 'success', text: 'forceTierOnExplicitModel: ' + v + '.' + saved }
            }
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
            const agent = invocation.agent
            if (!agent) return { kind: 'error', text: 'tier plan requires a calling agent (per-session state).' }
            // auto is needed only where routing does not run (off/delegated
            // would leave the plan on the baseline/parent route); every other
            // mode already routes, and smart pins the plan tier on its own —
            // entering plan mode must not silently rewrite it to auto.
            if (effectiveMode(agent) === 'off' || effectiveMode(agent) === 'delegated') {
              sessionModes.set(agent, 'auto')
            }
            clearRoutingTransients(agent)
            const outcome = setPlanMode(agent, true)
            const effective = effectiveMode(agent)
            const targetTier = TIER_SLOTS.indexOf(effective) !== -1 ? effective : planTierName()
            applyTarget(agent, effectiveTarget(agent, targetTier))
            const routingText = effective === 'smart'
              ? 'smart (main agent stays on the ' + planTierName() + ' tier)'
              : effective === 'auto'
                ? 'auto (' + planTierName() + ' plans, cheap executes)'
                : effective
            return { kind: 'success', text: 'Plan mode: ' + outcome + '. Routing mode: ' + routingText + '.' }
          }
          if (sub === 'review') {
            if (!arg) return { kind: 'error', text: 'usage: /tier review <focus to review>' }
            const r = await runConsult('review', { focus: arg }, invocation.signal, invocation.agent)
            const head = r.skipped ? 'Review (decision model):' : 'Review (' + r.route.provider + '/' + r.route.model + '):'
            return { kind: 'success', text: head + '\n' + r.review }
          }
          return { kind: 'error', text: 'Unknown subcommand "' + sub + '". Use: status | strong | main | cheap | auto | delegated | off | smart | cache | plan | models | layout | roles | gate | set | effort | subagent | review' }
        } catch (e) {
          return { kind: 'error', text: 'tier command failed: ' + String(e && e.message || e) }
        }
      },
    }))
  }

  if (promptMode === 'pi' && seams.tools && seams.fsResolve && seams.fsReadText && seams.fsWriteText && seams.fsEditText) {
    const minimalTools = createMinimalFsTools({ fs: services.fs, getCwd: () => sessionRoot(), sandboxPolicy: services.sandboxPolicy })
    for (const tool of minimalTools) {
      safeRegister('minimal fs tool ' + tool.name, () => tools.register(tool))
    }
  }

  if (seams.systemPrompt) {
    safeRegister('prompt section', () => systemPrompt.section({
      name: 'tier-routing',
      order: 120,
      text: function () {
        return tierPromptSection({
          promptMode,
          mode: state.mode,
          threeTiers: state.threeTiers,
          planTier: planTierName(),
          strongLabel: tierLabel(state.tiers.get('strong')),
          mainLabel: tierLabel(state.tiers.get('main')),
          cheapLabel: tierLabel(state.tiers.get('cheap')),
          strongChain: chainText({ fallback: chainFor('strong') }),
          cheapChain: chainText({ fallback: chainFor('cheap') }),
          subagentPolicy: state.subagentPolicy,
          fallbackTtlSec: Math.round(state.fallbackTtlMs / 1000),
          advisorMax: state.advisorMaxCallsPerTurn,
          advisorTimeoutSec: state.advisorConfirmTimeoutSec,
        }).join('\n')
      },
    }))
  }

  log(ctx, 'info', 'tier: active — seam=' + seamMode + ' mode=' + state.mode + ' strong=' + tierLabel(state.tiers.get('strong')) + ' cheap=' + tierLabel(state.tiers.get('cheap')) + ' subagentPolicy=' + state.subagentPolicy + ' decision=' + (state.decisionModel || 'off') + ':' + (state.decisionStages.join(',') || 'none') + ' persist=' + (bridge.readable ? 'settings:' + HOST_SETTINGS_NS : 'memory') + ' seams: ' + seamReport(seams))
}





