// dsh-tier-orchestrator client — the WebUI configuration surface (browser half).
//
// Three seats, all on the Plugins page where users actually look:
//   plugins.bundle.config  key 'dsh-tier-orchestrator'                     — the
//       bundle page renders the form between the description and the
//       component rows;
//   plugins.row.config     key 'dsh-tier-orchestrator#tier-routing'        — makes
//       the host-plane `tier-routing` component row clickable and opens the
//       same form as its own page;
//   shell.overlay          — a floating result panel for `/tier` and
//       `/advisor`, because a slash command writes no turn: in a brand-new
//       session the transcript stays on the hero screen.
//
// Model choices come from `remote.session.modelCatalog()`, the same answer
// the session model picker uses, so the lists match the app. The catalog is
// never cached when it is empty or failed: it is re-read on open, on
// `llm/adapters-updated`, on `settings/document-updated`, and on demand.
//
// Hand-authored CJS bundle (no build step): the host ModuleLoader resolves
// `react` and `@deepseek-ai/dsh-client-ui-primitives` by id.

window.__ModuleLoader__.load({ id: "dsh-tier-orchestrator", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

const React = require('react')
const h = React.createElement
const P = require('@deepseek-ai/dsh-client-ui-primitives')
const useState = React.useState
const useEffect = React.useEffect

// ---- locale ---------------------------------------------------------------

const NS = 'settings.tierRouting'
const SETTINGS_NS = 'tier-routing'
const BUNDLE_NAME = 'dsh-tier-orchestrator'
const ROW_KEY = BUNDLE_NAME + '#' + SETTINGS_NS

const en = {
  title: 'Tier routing',
  description: 'Strong model for planning and review, a cheaper model for implementation, with fallback chains and failure escalation.',
  unavailable: 'The tier-routing settings entry is not served yet. Start a session on the tiered preset once, then this card becomes configurable.',
  readOnly: 'This deployment stores settings read-only.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalid: 'Enter one of the listed values, or leave blank to use the default.',
  invalidJson: 'Enter a JSON array, or leave blank to clear.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  refresh: 'Refresh',

  mode: 'Routing mode',
  modeHint: 'auto | strong | cheap | delegated | off | smart. auto: plan mode uses strong, execution uses cheap. delegated: only subagents are tiered. smart: the main agent plans/reviews and delegates file edits to sidekicks.',
  strongRoute: 'Strong model',
  cheapRoute: 'Cheap model',
  routeHint: 'The same catalog the session picker uses. A route the catalog does not list: choose "Route not listed".',
  providerLabel: 'Provider',
  modelLabel: 'Model',
  pickRoute: 'Choose a model…',
  customRoute: 'Route not listed',
  listedRoute: 'Pick from list',
  strongEffort: 'Strong reasoning effort',
  cheapEffort: 'Cheap reasoning effort',
  effortHint: 'The levels the selected model declares. A level it does not declare is fitted automatically before the request.',
  effortDefault: 'model default',
  effortNone: 'This model declares no reasoning levels; the router sends none.',
  effortManual: 'low | medium | high | max, or blank for the model default.',
  strongFallback: 'Strong fallback chain',
  cheapFallback: 'Cheap fallback chain',
  fallbackHint: 'JSON array of {"provider":"…","model":"…","reasoningEffort":"…"} entries tried in order when the main route is unavailable.',
  subagentPolicy: 'Subagent tier policy',
  policyHint: 'inherit | strong | cheap | main | caller | capped. Which route subagents run on; caller uses the parent\'s current route; capped does the same but never above main.',
  spawnPolicy: 'Spawn subagent policy',
  spawnPolicyHint: 'Overrides the policy above for the built-in subagent tool (fresh children). Blank = use the policy above. caller is not allowed here.',
  forkPolicy: 'Fork subagent policy',
  forkPolicyHint: 'Overrides the policy above for subagent_fork (children that carry the parent history). Blank = use the policy above.',
  planMinExplore: 'Plan: read/search calls before exit_plan_mode',
  planMinExploreHint: 'Whole number. The plan is refused until the agent has read or searched the code this many times in plan mode. 0 disables the check.',
  planAdvisorGate: 'Plan: advisor review before presenting',
  planAdvisorGateHint: 'true | false. true: the advisor reviews each plan once, and its advice goes back to the agent before you see the plan.',
  sidekickExploreRoute: 'Sidekick explore model',
  sidekickImplementRoute: 'Sidekick implement model',
  sidekickFixRoute: 'Sidekick fix model',
  sidekickExploreEffort: 'Sidekick explore effort',
  sidekickImplementEffort: 'Sidekick implement effort',
  sidekickFixEffort: 'Sidekick fix effort',
  sidekickHint: 'Optional per-stage model for smart-mode sidekicks. Blank = the cheap tier route.',
  advisorMaxCallsPerTurn: 'Advisor max calls per turn',
  advisorMaxCallsPerTurnHint: 'Whole number. The next call past this limit asks for confirmation before running.',
  advisorConfirmTimeoutSec: 'Advisor confirm timeout (s)',
  advisorConfirmTimeoutSecHint: 'Seconds to wait for the confirmation on the call past the limit. 0 disables asking (the extra call is denied).',
  forceTierOnExplicitModel: 'Force tier on explicit model',
  forceTierOnExplicitModelHint: 'true | false. true: subagent children with an explicit model are still routed by tier/policy rules instead of keeping their seed route.',
  threeTiers: 'Three-tier layout',
  threeTiersHint: 'true | false. false: strong plans, cheap executes. true: main plans, cheap executes, strong is the escalation tier.',
  mainRoute: 'Main model',
  mainEffort: 'Main reasoning effort',
  mainFallback: 'Main fallback chain',
  rolesEnabled: 'Advisor and reviewer roles',
  rolesHint: 'true | false. false: advisor and reviewer use the strong route. true: they use the models below.',
  advisorRoute: 'Advisor model',
  advisorEffort: 'Advisor reasoning effort',
  reviewerRoute: 'Reviewer model',
  reviewerEffort: 'Reviewer reasoning effort',
  roleHint: 'A role has no chain of its own: when its model is unavailable, the strong fallback chain takes over. Leave blank to use the strong route.',

  catalogLoading: 'Reading the model catalog…',
  catalogEmpty: 'The model catalog is empty: no provider has registered models yet. Press Refresh after the providers finish loading.',
  catalogError: 'The model catalog could not be read',
  providersCount: 'Providers',
  modelsCount: 'Models',
  failuresTitle: 'Providers that could not list their models',

  cmdRunning: 'Running…',
  cmdFailed: 'failed',
  noticeClose: 'Close',
}

const zh = {
  title: 'Tier 路由',
  description: '规划与审查走强模型，日常实现走低成本模型，带降级链路与失败自动升级。',
  unavailable: 'tier-routing 设置项尚未注册。先用 tiered 预设新建一个会话，此卡片即可配置。',
  readOnly: '本部署的设置为只读。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalid: '请输入列出的取值之一，或留空使用默认值。',
  invalidJson: '请输入 JSON 数组，或留空清除。',
  overridden: '已覆盖',
  reset: '恢复默认',
  refresh: '刷新',

  mode: '路由模式',
  modeHint: 'auto | strong | cheap | delegated | off | smart。auto：计划阶段走强档，执行阶段走低成本档；delegated：仅子代理分档；smart：主代理规划/审查，文件修改交给 sidekick。',
  strongRoute: '强档模型',
  cheapRoute: '低成本档模型',
  routeHint: '与会话选择器相同的目录。目录里没有的路由请选择“未列出的路由”。',
  providerLabel: '供应商',
  modelLabel: '模型',
  pickRoute: '选择模型…',
  customRoute: '未列出的路由',
  listedRoute: '从列表选择',
  strongEffort: '强档推理强度',
  cheapEffort: '低成本档推理强度',
  effortHint: '所选模型声明的强度档位。模型未声明的档位会在请求前自动适配。',
  effortDefault: '模型默认',
  effortNone: '该模型不声明推理强度档位，路由不会发送。',
  effortManual: 'low | medium | high | max，留空使用模型默认。',
  strongFallback: '强档降级链',
  cheapFallback: '低成本档降级链',
  fallbackHint: 'JSON 数组，元素形如 {"provider":"…","model":"…","reasoningEffort":"…"}，主路由不可用时按序尝试。',
  subagentPolicy: '子代理档位策略',
  policyHint: 'inherit | strong | cheap | main | caller | capped。子代理使用的路由；caller 使用父代理当前路由；capped 同样，但不高于 main。',
  spawnPolicy: '全新子代理策略',
  spawnPolicyHint: '覆盖上面的策略，作用于内置 subagent 工具（全新子代理）。留空则使用上面的策略。此处不允许 caller。',
  forkPolicy: 'fork 子代理策略',
  forkPolicyHint: '覆盖上面的策略，作用于 subagent_fork（携带父代理历史的子代理）。留空则使用上面的策略。',
  planMinExplore: '计划：提交前的读取/搜索次数',
  planMinExploreHint: '整数。计划模式中代理读取或搜索代码达到此次数前，计划会被拒绝。0 表示关闭检查。',
  planAdvisorGate: '计划：提交前顾问审查',
  planAdvisorGateHint: 'true | false。true：顾问对每份计划审查一次，建议先返回给代理，再由你看到计划。',
  sidekickExploreRoute: 'Sidekick 探索模型',
  sidekickImplementRoute: 'Sidekick 实现模型',
  sidekickFixRoute: 'Sidekick 修复模型',
  sidekickExploreEffort: 'Sidekick 探索推理强度',
  sidekickImplementEffort: 'Sidekick 实现推理强度',
  sidekickFixEffort: 'Sidekick 修复推理强度',
  sidekickHint: 'smart 模式下各阶段的可选模型。留空使用低成本档路由。',
  advisorMaxCallsPerTurn: '顾问每轮最大调用次数',
  advisorMaxCallsPerTurnHint: '整数。超过该次数后，下一次调用需要确认。',
  advisorConfirmTimeoutSec: '顾问确认超时（秒）',
  advisorConfirmTimeoutSecHint: '等待确认的秒数。0 表示不询问并直接拒绝超限调用。',
  forceTierOnExplicitModel: '显式模型也强制分档',
  forceTierOnExplicitModelHint: 'true | false。true：带显式模型的子代理仍按档位/策略路由，而不是保留种子路由。',
  threeTiers: '三档布局',
  threeTiersHint: 'true | false。false：强档规划，低成本档执行。true：主档规划，低成本档执行，强档作为升级档。',
  mainRoute: '主档模型',
  mainEffort: '主档推理强度',
  mainFallback: '主档降级链',
  rolesEnabled: '顾问与审查角色',
  rolesHint: 'true | false。false：顾问与审查走强档路由。true：使用下面配置的模型。',
  advisorRoute: '顾问模型',
  advisorEffort: '顾问推理强度',
  reviewerRoute: '审查模型',
  reviewerEffort: '审查推理强度',
  roleHint: '角色没有自己的降级链：其模型不可用时，接管的是强档降级链。留空则走强档路由。',

  catalogLoading: '正在读取模型目录…',
  catalogEmpty: '模型目录为空：还没有供应商注册模型。供应商加载完成后点击“刷新”。',
  catalogError: '无法读取模型目录',
  providersCount: '供应商',
  modelsCount: '模型',
  failuresTitle: '无法列出模型的供应商',

  cmdRunning: '执行中…',
  cmdFailed: '失败',
  noticeClose: '关闭',
}

function formLabels(t) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

// ---- pure catalog helpers (exported for tests) -----------------------------

const ROUTE_SEP = '\u001f'

/** One option value per provider/model pair; model ids may contain slashes. */
function routeValue(provider, model) { return provider + ROUTE_SEP + model }

/** Inverse of routeValue, or null for a value that is not a route. */
function splitRoute(value) {
  const at = String(value).indexOf(ROUTE_SEP)
  if (at < 0) return null
  return { provider: String(value).slice(0, at), model: String(value).slice(at + 1) }
}

/**
 * Normalize a `remote.session.modelCatalog()` value (groups + failures) into
 * the view the form renders. Providers without models are dropped; the
 * per-model reasoning declaration is kept so the effort list can follow it.
 * @param value - the catalog value, or undefined before the first read.
 */
function catalogView(value) {
  const groups = value && Array.isArray(value.groups) ? value.groups : []
  const providers = []
  for (const group of groups) {
    if (!group || typeof group.id !== 'string') continue
    const models = []
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (!model || typeof model.id !== 'string') continue
      const reasoning = model.reasoning && typeof model.reasoning === 'object' ? model.reasoning : null
      models.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name ? model.name : model.id,
        efforts: reasoning && Array.isArray(reasoning.efforts)
          ? reasoning.efforts.map((e) => e && e.id).filter((id) => typeof id === 'string')
          : [],
        defaultEffort: reasoning && typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : null,
      })
    }
    if (models.length > 0) {
      providers.push({ id: group.id, name: typeof group.name === 'string' && group.name ? group.name : group.id, models })
    }
  }
  const failures = (value && Array.isArray(value.failures) ? value.failures : [])
    .filter((f) => f && typeof f.id === 'string')
    .map((f) => ({ id: f.id, name: typeof f.name === 'string' && f.name ? f.name : f.id, message: String(f.message || '') }))
  const models = providers.reduce((count, provider) => count + provider.models.length, 0)
  return { providers, failures, models }
}

function findModel(view, provider, model) {
  const group = view.providers.find((p) => p.id === provider)
  return group ? group.models.find((m) => m.id === model) : undefined
}

/**
 * The effort choices of one route. null when the route is not in the catalog
 * (its declaration is unknown, so the level stays free text); `efforts: []`
 * when the catalog lists the model without reasoning support.
 */
function effortChoices(view, provider, model) {
  const found = findModel(view, provider, model)
  if (!found) return null
  return { efforts: found.efforts, defaultEffort: found.defaultEffort }
}

// ---- tiny observable -------------------------------------------------------
// Slot hooks read `getSnapshot`/`subscribe`; this is the minimal shape.

function observable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * The model catalog as shared state. A ready catalog with models is kept;
 * an empty, failed or loading one is read again on the next load.
 * @param ctx - the browser plugin context whose `remote.session` answers.
 */
function createCatalog(ctx) {
  const state = observable({ status: 'idle', view: catalogView(undefined), error: null })
  let inflight = null
  function load(force) {
    if (inflight !== null) return inflight
    const current = state.getSnapshot()
    if (!force && current.status === 'ready') return Promise.resolve()
    state.set({ status: 'loading', view: current.view, error: null })
    inflight = (async () => {
      try {
        const response = await ctx.remote.session.modelCatalog()
        if (!response || response.ok !== true) {
          throw new Error(response && response.error ? response.error.message : 'modelCatalog failed')
        }
        const view = catalogView(response.value)
        state.set({ status: view.models > 0 ? 'ready' : 'empty', view, error: null })
      } catch (error) {
        state.set({ status: 'error', view: current.view, error: String(error && error.message || error) })
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
  return { state, load }
}

// ---- field specs -----------------------------------------------------------
// SettingsFormModel stages plain text per field; these specs convert between
// the stored value and the draft text (the primitives ship text/number
// helpers only, so enums, booleans and JSON chains get local specs).

function enumField(field, values) {
  return {
    field,
    format: (v) => (typeof v === 'string' ? v : ''),
    parse: (text) => {
      const t = String(text).trim()
      if (t === '') return { kind: 'clear' }
      return values.includes(t) ? { kind: 'set', value: t } : undefined
    },
  }
}

function boolField(field) {
  return {
    field,
    format: (v) => (v === true ? 'true' : v === false ? 'false' : ''),
    parse: (text) => {
      const t = String(text).trim().toLowerCase()
      if (t === '') return { kind: 'clear' }
      if (t === 'true' || t === '1' || t === 'yes') return { kind: 'set', value: true }
      if (t === 'false' || t === '0' || t === 'no') return { kind: 'set', value: false }
      return undefined
    },
  }
}

function chainField(field) {
  const ok = (e) => e && typeof e === 'object'
    && typeof e.provider === 'string' && typeof e.model === 'string'
    && typeof e.reasoningEffort === 'string'
  return {
    field,
    format: (v) => (Array.isArray(v) && v.length ? JSON.stringify(v) : ''),
    parse: (text) => {
      const t = String(text).trim()
      if (t === '') return { kind: 'clear' }
      try {
        const v = JSON.parse(t)
        return Array.isArray(v) && v.every(ok) ? { kind: 'set', value: v } : undefined
      } catch (e) {
        return undefined
      }
    },
  }
}

const SPECS = [
  enumField('mode', ['auto', 'strong', 'cheap', 'delegated', 'off', 'smart']),
  boolField('threeTiers'),
  P.settingsTextField('strongProvider'),
  P.settingsTextField('strongModel'),
  P.settingsTextField('strongEffort'),
  chainField('strongFallback'),
  P.settingsTextField('mainProvider'),
  P.settingsTextField('mainModel'),
  P.settingsTextField('mainEffort'),
  chainField('mainFallback'),
  P.settingsTextField('cheapProvider'),
  P.settingsTextField('cheapModel'),
  P.settingsTextField('cheapEffort'),
  chainField('cheapFallback'),
  boolField('rolesEnabled'),
  P.settingsTextField('advisorProvider'),
  P.settingsTextField('advisorModel'),
  P.settingsTextField('advisorEffort'),
  P.settingsTextField('reviewerProvider'),
  P.settingsTextField('reviewerModel'),
  P.settingsTextField('reviewerEffort'),
  enumField('subagentPolicy', ['inherit', 'strong', 'cheap', 'main', 'caller', 'capped']),
  enumField('spawnPolicy', ['', 'inherit', 'strong', 'cheap', 'main', 'capped']),
  enumField('forkPolicy', ['', 'inherit', 'strong', 'cheap', 'main', 'caller', 'capped']),
  P.settingsNumberField('planMinExplore'),
  boolField('planAdvisorGate'),
  P.settingsTextField('sidekickExploreProvider'),
  P.settingsTextField('sidekickExploreModel'),
  P.settingsTextField('sidekickExploreEffort'),
  P.settingsTextField('sidekickImplementProvider'),
  P.settingsTextField('sidekickImplementModel'),
  P.settingsTextField('sidekickImplementEffort'),
  P.settingsTextField('sidekickFixProvider'),
  P.settingsTextField('sidekickFixModel'),
  P.settingsTextField('sidekickFixEffort'),
  P.settingsNumberField('advisorMaxCallsPerTurn'),
  P.settingsNumberField('advisorConfirmTimeoutSec'),
  boolField('forceTierOnExplicitModel'),
]

/** Locale keys of each route slot: [route label, effort label]. */
const ROUTE_LABELS = {
  strong: ['strongRoute', 'strongEffort'],
  main: ['mainRoute', 'mainEffort'],
  cheap: ['cheapRoute', 'cheapEffort'],
  advisor: ['advisorRoute', 'advisorEffort'],
  reviewer: ['reviewerRoute', 'reviewerEffort'],
  sidekickExplore: ['sidekickExploreRoute', 'sidekickExploreEffort'],
  sidekickImplement: ['sidekickImplementRoute', 'sidekickImplementEffort'],
  sidekickFix: ['sidekickFixRoute', 'sidekickFixEffort'],
}

// ---- controls --------------------------------------------------------------

const labelStyle = {
  display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4,
  color: 'var(--dsw-alias-label-secondary)',
}

const captionStyle = { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }

const inputStyle = {
  boxSizing: 'border-box', padding: '7px 10px', fontSize: 13, lineHeight: '20px',
  fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', width: '100%',
  background: 'var(--dsw-specific-input-major)',
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, outline: 'none',
}

const linkButtonStyle = {
  padding: '0 4px', fontSize: 12, cursor: 'pointer', background: 'transparent',
  color: 'var(--dsw-alias-brand-primary)', border: 'none',
}

const errorTextStyle = { margin: '4px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }

function fieldId(key) { return 'plugin-config-tier-routing-' + key }

function textOf(state, key) {
  return state[key] && typeof state[key].text === 'string' ? state[key].text : ''
}

/** Plain staged text control: the shared settings field for booleans, chains, mode and policy. */
function TextField(props) {
  const { t, state, fieldKey, labelKey, hintKey, disabled, invalidJson } = props
  return h(P.SettingsValueField, {
    id: fieldId(fieldKey),
    label: t(labelKey || fieldKey),
    hint: t(hintKey),
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t(invalidJson ? 'invalidJson' : 'invalid'),
    disabled,
    ...state[fieldKey],
    onEdit: (text) => props.edit(fieldKey, text),
    onReset: () => props.resetField(fieldKey),
  })
}

/** A label row with its overridden marker and an optional action. */
function FieldHeader(props) {
  return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 } },
    h('label', { htmlFor: props.id, style: { ...labelStyle, marginBottom: 0 } }, props.label),
    props.overridden ? h('span', { style: captionStyle }, props.overriddenLabel) : null,
    h('span', { style: { flex: 1 } }),
    props.action || null)
}

/** Catalog state line: counts when loaded, the reason otherwise, plus Refresh and provider failures. */
function CatalogStatus(props) {
  const { t, catalog, refresh } = props
  const view = catalog.view
  const loading = catalog.status === 'loading'
  const line = loading ? t('catalogLoading')
    : catalog.status === 'error' ? t('catalogError') + ': ' + catalog.error
      : catalog.status === 'empty' ? t('catalogEmpty')
        : t('providersCount') + ': ' + view.providers.length + ' · ' + t('modelsCount') + ': ' + view.models
  const bad = catalog.status === 'error' || catalog.status === 'empty'
  return h('div', { style: { margin: '0 0 12px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('span', { style: { fontSize: 12, flex: 1, color: bad ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' } }, line),
      h('button', { type: 'button', style: linkButtonStyle, disabled: loading, onClick: () => refresh() }, t('refresh'))),
    view.failures.length > 0
      ? h('div', { style: { marginTop: 6 } },
        h('div', { style: captionStyle }, t('failuresTitle')),
        ...view.failures.map((f) => h('div', { key: f.id, style: { ...captionStyle, color: 'var(--dsw-alias-state-error-primary)' } }, f.name + ': ' + f.message)))
      : null)
}

/**
 * One tier's model route and reasoning effort. The model is one grouped
 * dropdown (a group per provider, the same as the session picker); the
 * effort dropdown lists the levels the chosen model declares. Routes the
 * catalog does not list, or a catalog that is empty, fall back to text.
 */
function RouteField(props) {
  const { t, state, tier, catalog, disabled, edit, resetField, customOn, onToggleCustom } = props
  const providerKey = tier + 'Provider'
  const modelKey = tier + 'Model'
  const effortKey = tier + 'Effort'
  const provider = textOf(state, providerKey)
  const model = textOf(state, modelKey)
  const effortText = textOf(state, effortKey)
  const view = catalog.view
  const hasCatalog = view.models > 0
  const typing = customOn || !hasCatalog
  const listed = !!findModel(view, provider, model)
  const current = provider === '' && model === '' ? '' : routeValue(provider, model)
  const choice = effortChoices(view, provider, model)
  const routeLabel = t(ROUTE_LABELS[tier][0])
  const effortLabel = t(ROUTE_LABELS[tier][1])
  const routeOverridden = !!(state[providerKey] && state[providerKey].overridden) || !!(state[modelKey] && state[modelKey].overridden)

  const choose = (value) => {
    const route = splitRoute(value)
    if (!route) return
    edit(providerKey, route.provider)
    edit(modelKey, route.model)
    const next = effortChoices(view, route.provider, route.model)
    if (next && next.efforts.length > 0 && effortText !== '' && next.efforts.indexOf(effortText) === -1) edit(effortKey, '')
  }

  const toggle = hasCatalog && props.onToggleCustom
    ? h('button', { type: 'button', style: linkButtonStyle, disabled, onClick: onToggleCustom }, t(customOn ? 'listedRoute' : 'customRoute'))
    : null
  const reset = routeOverridden
    ? h('button', { type: 'button', style: linkButtonStyle, disabled, onClick: () => { resetField(providerKey); resetField(modelKey) } }, t('reset'))
    : null

  const routeControl = typing
    ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
      h('input', {
        id: fieldId(providerKey), type: 'text', value: provider, disabled, placeholder: t('providerLabel'),
        style: inputStyle, onChange: (event) => edit(providerKey, event.target.value),
      }),
      h('input', {
        id: fieldId(modelKey), type: 'text', value: model, disabled, placeholder: t('modelLabel'),
        style: inputStyle, onChange: (event) => edit(modelKey, event.target.value),
      }))
    : h('select', {
      id: fieldId(tier + 'Route'), value: current, disabled, style: inputStyle,
      onChange: (event) => choose(event.target.value),
    },
      h('option', { value: '' }, t('pickRoute')),
      current !== '' && !listed ? h('option', { value: current }, provider + ' / ' + model) : null,
      ...view.providers.map((group) => h('optgroup', { key: group.id, label: group.name },
        ...group.models.map((m) => h('option', { key: group.id + ROUTE_SEP + m.id, value: routeValue(group.id, m.id) },
          m.name === m.id ? m.id : m.name + ' · ' + m.id)))))

  let effortControl
  if (choice === null) {
    effortControl = h('input', {
      id: fieldId(effortKey), type: 'text', value: effortText, disabled, placeholder: t('effortManual'),
      style: inputStyle, onChange: (event) => edit(effortKey, event.target.value),
    })
  } else if (choice.efforts.length === 0) {
    effortControl = h('p', { style: captionStyle }, t('effortNone'))
  } else {
    const levels = choice.efforts
    effortControl = h('select', {
      id: fieldId(effortKey), value: effortText, disabled, style: inputStyle,
      onChange: (event) => edit(effortKey, event.target.value),
    },
      h('option', { value: '' }, t('effortDefault') + (choice.defaultEffort ? ' (' + choice.defaultEffort + ')' : '')),
      effortText !== '' && levels.indexOf(effortText) === -1 ? h('option', { value: effortText }, effortText) : null,
      ...levels.map((level) => h('option', { key: level, value: level }, level + (level === choice.defaultEffort ? ' · default' : ''))))
  }

  const effortReset = state[effortKey] && state[effortKey].overridden
    ? h('button', { type: 'button', style: linkButtonStyle, disabled, onClick: () => resetField(effortKey) }, t('reset'))
    : null

  return h('div', { style: { margin: '2px 0 10px' } },
    FieldHeader({ id: fieldId(tier + 'Route'), label: routeLabel, overridden: routeOverridden, overriddenLabel: t('overridden'), action: h('span', null, toggle, reset) }),
    routeControl,
    h('p', { style: { ...captionStyle, margin: '4px 0 12px' } }, t(tier === 'advisor' || tier === 'reviewer' ? 'roleHint' : 'routeHint')),
    FieldHeader({ id: fieldId(effortKey), label: effortLabel, overridden: !!(state[effortKey] && state[effortKey].overridden), overriddenLabel: t('overridden'), action: effortReset }),
    effortControl,
    h('p', { style: { ...captionStyle, margin: '4px 0 0' } }, t('effortHint')))
}

/** One-liner on a card, or the staged settings form. */
function TierRoutingCard(props) {
  const t = props.t
  const state = props.useTierRoutingCard((snapshot) => snapshot)
  const catalog = props.useModelCatalog((snapshot) => snapshot)
  const [custom, setCustom] = useState({ strong: false, main: false, cheap: false, advisor: false, reviewer: false, sidekickExplore: false, sidekickImplement: false, sidekickFix: false })
  const loadCatalog = props.loadCatalog
  useEffect(() => {
    if (props.view !== 'summary') loadCatalog()
  }, [])
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  const common = { t, state, catalog, disabled, edit: props.edit, resetField: props.resetField }
  const toggleCustom = (tier) => () => setCustom((current) => ({ ...current, [tier]: !current[tier] }))
  return h(P.SettingsForm, {
    labels: formLabels(t),
    state,
    onSave: props.save,
    onDiscard: props.discard,
  },
    h(CatalogStatus, { t, catalog, refresh: props.refreshCatalog }),
    h(TextField, { ...common, fieldKey: 'mode', labelKey: 'mode', hintKey: 'modeHint' }),
    h(TextField, { ...common, fieldKey: 'threeTiers', labelKey: 'threeTiers', hintKey: 'threeTiersHint' }),
    h(RouteField, { ...common, tier: 'strong', customOn: custom.strong, onToggleCustom: toggleCustom('strong') }),
    h(TextField, { ...common, fieldKey: 'strongFallback', labelKey: 'strongFallback', hintKey: 'fallbackHint', invalidJson: true }),
    h(RouteField, { ...common, tier: 'main', customOn: custom.main, onToggleCustom: toggleCustom('main') }),
    h(TextField, { ...common, fieldKey: 'mainFallback', labelKey: 'mainFallback', hintKey: 'fallbackHint', invalidJson: true }),
    h(RouteField, { ...common, tier: 'cheap', customOn: custom.cheap, onToggleCustom: toggleCustom('cheap') }),
    h(TextField, { ...common, fieldKey: 'cheapFallback', labelKey: 'cheapFallback', hintKey: 'fallbackHint', invalidJson: true }),
    h(TextField, { ...common, fieldKey: 'rolesEnabled', labelKey: 'rolesEnabled', hintKey: 'rolesHint' }),
    h(RouteField, { ...common, tier: 'advisor', customOn: custom.advisor, onToggleCustom: toggleCustom('advisor') }),
    h(RouteField, { ...common, tier: 'reviewer', customOn: custom.reviewer, onToggleCustom: toggleCustom('reviewer') }),
    h(TextField, { ...common, fieldKey: 'subagentPolicy', labelKey: 'subagentPolicy', hintKey: 'policyHint' }),
    h(TextField, { ...common, fieldKey: 'spawnPolicy', labelKey: 'spawnPolicy', hintKey: 'spawnPolicyHint' }),
    h(TextField, { ...common, fieldKey: 'forkPolicy', labelKey: 'forkPolicy', hintKey: 'forkPolicyHint' }),
    h(TextField, { ...common, fieldKey: 'planMinExplore', labelKey: 'planMinExplore', hintKey: 'planMinExploreHint' }),
    h(TextField, { ...common, fieldKey: 'planAdvisorGate', labelKey: 'planAdvisorGate', hintKey: 'planAdvisorGateHint' }),
    h('p', { style: { ...captionStyle, margin: '10px 0 2px', fontWeight: 600 } }, t('sidekickRoute')),
    h('p', { style: { ...captionStyle, margin: '0 0 6px' } }, t('sidekickHint')),
    h(RouteField, { ...common, tier: 'sidekickExplore', customOn: custom.sidekickExplore, onToggleCustom: toggleCustom('sidekickExplore') }),
    h(RouteField, { ...common, tier: 'sidekickImplement', customOn: custom.sidekickImplement, onToggleCustom: toggleCustom('sidekickImplement') }),
    h(RouteField, { ...common, tier: 'sidekickFix', customOn: custom.sidekickFix, onToggleCustom: toggleCustom('sidekickFix') }),
    h(TextField, { ...common, fieldKey: 'advisorMaxCallsPerTurn', labelKey: 'advisorMaxCallsPerTurn', hintKey: 'advisorMaxCallsPerTurnHint' }),
    h(TextField, { ...common, fieldKey: 'advisorConfirmTimeoutSec', labelKey: 'advisorConfirmTimeoutSec', hintKey: 'advisorConfirmTimeoutSecHint' }),
    h(TextField, { ...common, fieldKey: 'forceTierOnExplicitModel', labelKey: 'forceTierOnExplicitModel', hintKey: 'forceTierOnExplicitModelHint' }))
}

/** Staged form over the `tier-routing` settings namespace. */
class TierRoutingCardController {
  /** @param scope - the bound settings scope for the namespace. */
  constructor(scope) {
    this.form = new P.SettingsFormModel(scope, SPECS)
    this.store = this.form.bind(() => this.projection())
  }

  projection() {
    const out = { ...this.form.shell() }
    for (const spec of SPECS) out[spec.field] = this.form.field(spec.field)
    return out
  }

  /** Face the slot registration injects into the card. */
  inject() {
    return {
      hooks: { tierRoutingCard: this.store },
      ...this.form.actions(),
    }
  }

  dispose() {
    this.form.dispose()
  }
}

/**
 * Expanded renderer for /tier and /advisor results inside the transcript.
 * @param props - the flow node's command data and the locale reader.
 */
function TierCommandView(props) {
  const node = props.node
  const t = props.t
  const outcome = node && node.outcome
  const text = outcome && typeof outcome.text === 'string' ? outcome.text : null
  const running = outcome === null || outcome === undefined
  const failed = outcome !== null && outcome !== undefined && outcome.kind === 'error'
  const dotColor = failed
    ? 'var(--dsw-alias-state-error-primary)'
    : (running ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-success-primary)')
  return h('div', {
    style: {
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12,
      padding: '10px 14px', margin: '2px 0',
      background: 'var(--dsw-alias-bg-layer-1)',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: text === null ? 0 : 8 } },
      h('span', { style: { color: dotColor, fontSize: 13, width: 14 } },
        failed ? '✕' : (running ? '…' : '✓')),
      h('b', { style: { fontSize: 13 } }, '/' + (node && node.name || 'tier')),
      failed ? h('span', { style: { fontSize: 12, color: dotColor } }, t('cmdFailed')) : null),
    text === null
      ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('cmdRunning'))
      : h('pre', {
        style: {
          margin: 0, padding: '12px 14px', overflow: 'auto', maxHeight: 420,
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
          background: 'var(--dsw-alias-markdown-code-block)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      }, text))
}

/**
 * Floating result panel for a slash command. A command writes no turn, so a
 * brand-new session stays on the hero screen and the transcript node is not
 * visible; this panel shows the same text immediately, from any phase.
 * @param props - the notice snapshot and its dismiss action.
 */
function CommandNoticePanel(props) {
  const t = props.t
  const notice = props.useCommandNotice((snapshot) => snapshot)
  if (notice.text === null) return null
  const failed = notice.kind === 'error'
  return h('div', {
    style: {
      position: 'fixed', right: 16, bottom: 16, zIndex: 40,
      maxWidth: 'min(560px, calc(100vw - 32px))', maxHeight: '60vh',
      display: 'flex', flexDirection: 'column',
      border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 14,
      background: 'var(--dsw-alias-bg-layer-1)',
      boxShadow: 'var(--dsw-shadow-lv2, var(--dsw-elevation-prominent, none))',
      padding: '10px 12px',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
      h('span', {
        style: {
          color: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
          fontSize: 13,
        },
      }, failed ? '✕' : '✓'),
      h('b', { style: { fontSize: 13 } }, '/' + notice.name),
      h('span', { style: { flex: 1 } }),
      h('button', {
        type: 'button',
        onClick: props.dismiss,
        'aria-label': t('noticeClose'),
        style: {
          cursor: 'pointer', background: 'transparent', border: 'none',
          color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '18px',
        },
      }, '✕')),
    h('pre', {
      style: {
        margin: 0, padding: '10px 12px', overflow: 'auto',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
        background: 'var(--dsw-alias-markdown-code-block)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
    }, notice.text))
}

// ---- plugin ----------------------------------------------------------------

const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tier-orchestrator: dictionaries')

  const card = new TierRoutingCardController(ctx.configForms.get(SETTINGS_NS))
  ctx.effect(() => () => card.dispose(), 'dsh-tier-orchestrator: form subscription')

  const catalog = createCatalog(ctx)
  ctx.effect(() => [
    ctx.remote.$on('llm/adapters-updated', () => { catalog.load(true) }),
    ctx.remote.$on('settings/document-updated', () => { catalog.load(true) }),
  ], 'dsh-tier-orchestrator: catalog invalidations')
  ctx.on('connection/reset', () => { catalog.load(true) })

  const face = () => {
    const base = card.inject()
    return {
      ...base,
      hooks: { ...base.hooks, modelCatalog: catalog.state },
      loadCatalog: () => { catalog.load(false) },
      refreshCatalog: () => { catalog.load(true) },
    }
  }

  // A bundle's own configuration renders on the bundle's page; a row's
  // configuration makes that component row clickable and opens its page.
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    locale: NS,
    inject: face,
  }, TierRoutingCard)), 'dsh-tier-orchestrator: bundle configuration')

  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_KEY,
    locale: NS,
    inject: face,
  }, TierRoutingCard)), 'dsh-tier-orchestrator: row configuration')

  // /tier and /advisor results: expanded in the transcript and, because a
  // command writes no turn, also surfaced as a floating panel.
  const notice = observable({ seq: 0, name: 'tier', kind: null, text: null })
  let noticeSeq = 0
  const dismiss = () => notice.set({ seq: noticeSeq, name: 'tier', kind: null, text: null })
  ctx.effect(() => ctx.on('command/executed', (sessionId, name, result) => {
    if (name !== 'tier' && name !== 'advisor') return
    noticeSeq += 1
    const text = result && typeof result.text === 'string' ? result.text : null
    notice.set({
      seq: noticeSeq,
      name,
      kind: result && result.kind ? result.kind : 'success',
      text: text === null || text.trim() === '' ? '(no output)' : text,
    })
  }), 'dsh-tier-orchestrator: command results')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'tier-routing-command-result',
    locale: NS,
    inject: () => ({ hooks: { commandNotice: notice }, dismiss }),
  }, CommandNoticePanel)), 'dsh-tier-orchestrator: command result panel')

  for (const cmd of ['tier', 'advisor']) {
    ctx.effect(() => ctx.slots.inject('conversation.chat.commandview', () =>
      ctx.slots.register({
        name: 'conversation.chat.commandview',
        id: cmd,
        order: 0,
        key: cmd,
        locale: NS,
        inject: () => ({ t }),
      }, TierCommandView)), 'dsh-tier-orchestrator: commandview ' + cmd)
  }
}

exports.NS = NS
exports.apply = apply
exports.inject = inject
exports.routeValue = routeValue
exports.splitRoute = splitRoute
exports.catalogView = catalogView
exports.effortChoices = effortChoices
exports.createCatalog = createCatalog
exports.TierRoutingCard = TierRoutingCard
return module.exports;
}});
