// Browser-half checks for client/client.js. The bundle is a classic script that
// registers a ModuleLoader factory; the factory is evaluated here against
// stubbed `react` and primitives so the real module code runs under node.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DECISION_STAGES as CORE_DECISION_STAGES } from '../lib/core/decision.js'
import { Config } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const primitives = {
  settingsTextField: (field) => ({ field, format: () => '', parse: () => undefined }),
  settingsNumberField: (field) => ({ field, format: () => '', parse: () => undefined }),
  SettingsValueField() {},
  SettingsForm() {},
  SettingsFormModel: class {},
}
// A minimal hook store: the cell of the last rendered component survives
// until `react.__reset()`, so a re-render observes the new state.
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => {
    const cell = react.__cell || (react.__cell = { value })
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useEffect: () => {},
  __cell: null,
  __reset() { react.__cell = null },
}
const stubs = { react, '@deepseek-ai/dsh-client-ui-primitives': primitives }

function loadClient() {
  let registration = null
  globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry } } }
  new Function(readFileSync(join(ROOT, 'client', 'client.js'), 'utf8'))()
  const requireStub = (name) => {
    if (!(name in stubs)) throw new Error('unexpected require: ' + name)
    return stubs[name]
  }
  return registration.factory(requireStub)
}

const client = loadClient()

const sampleCatalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: { efforts: [{ id: 'off', name: 'off' }, { id: 'low', name: 'low' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }], defaultEffort: 'high' } },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', reasoning: { efforts: [{ id: 'high', name: 'high' }, { id: 'max', name: 'max' }] } },
      ],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [
        { id: 'minimax/minimax-m3.1-flash:free', name: 'MiniMax: MiniMax M3.1 Flash (free)' },
        { id: 'inception/mercury-3', name: 'Inception: Mercury 3', reasoning: { efforts: [] } },
      ],
    },
    { id: 'empty-provider', name: 'Empty', models: [] },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: 'QUOTA: out of credit' }],
}

const sampleDecisionCatalog = {
  data: [
    { id: 'typesafe/jev-1.14', name: 'TypeSafe: Jev 1.14', description: 'Jev 1.14 is the latest version', context_length: 262144, pricing: { prompt: 0.000000042, completion: 0 }, architecture: { modality: 'text+image->decisions', output_modalities: ['decisions'] } },
    { id: 'cloudflare/clef', name: 'Cloudflare: Clef', context_length: 65537, pricing: { prompt: 0.00000024, completion: 0 }, architecture: { modality: 'text->decisions', output_modalities: ['decisions'] } },
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: V4 Flash', pricing: { prompt: 0.0000001, completion: 0 }, architecture: { modality: 'text->text', output_modalities: ['text'] } },
    { id: 'typesafe/jev-router', name: 'TypeSafe: Jev Router', pricing: { prompt: -1, completion: -1 }, architecture: { modality: 'text->text', output_modalities: ['text'] } },
    { id: 'custom/decision-x', name: 'Custom', architecture: { output_modalities: ['decisions'] } },
    { id: 'custom/no-shape', name: 'No shape' },
    { id: 'custom/router', name: 'Router', pricing: { prompt: '-1', completion: '-1' }, architecture: { output_modalities: ['decisions'] } },
    { name: 'no id' },
    null,
  ],
}

test('routeValue and splitRoute round-trip model ids that contain slashes and colons', () => {
  const value = client.routeValue('openrouter', 'minimax/minimax-m3.1-flash:free')
  assert.deepEqual(client.splitRoute(value), { provider: 'openrouter', model: 'minimax/minimax-m3.1-flash:free' })
  assert.equal(client.splitRoute('no separator here'), null)
})

test('catalogView keeps providers with models, drops empty ones, and carries failures', () => {
  const view = client.catalogView(sampleCatalog)
  assert.deepEqual(view.providers.map((p) => p.id), ['deepseek-official', 'openrouter'])
  assert.equal(view.models, 4)
  assert.equal(view.providers[0].name, 'DeepSeek')
  assert.deepEqual(view.failures, [{ id: 'broken', name: 'Broken', message: 'QUOTA: out of credit' }])
})

test('catalogView falls back to ids when names are missing and tolerates garbage', () => {
  const view = client.catalogView({ groups: [null, { id: 'x', models: [{ id: 'm' }, 42] }, { models: [] }] })
  assert.deepEqual(view.providers, [{ id: 'x', name: 'x', models: [{ id: 'm', name: 'm', efforts: [], defaultEffort: null }] }])
  assert.equal(view.models, 1)
  assert.deepEqual(client.catalogView(undefined), { providers: [], failures: [], models: 0 })
})

test('effortChoices follows the model declaration', () => {
  const view = client.catalogView(sampleCatalog)
  assert.deepEqual(client.effortChoices(view, 'deepseek-official', 'deepseek-v4-flash'), {
    efforts: ['off', 'low', 'high', 'max'],
    defaultEffort: 'high',
  })
  assert.deepEqual(client.effortChoices(view, 'openrouter', 'inception/mercury-3'), { efforts: [], defaultEffort: null }, 'listed without reasoning')
  assert.equal(client.effortChoices(view, 'openrouter', 'not-listed'), null, 'unknown route keeps free text')
})

test('createCatalog keeps a non-empty catalog and re-reads an empty or failed one', async () => {
  const responses = []
  const ctx = {
    remote: {
      session: {
        modelCatalog: async () => {
          const next = responses.shift()
          if (next instanceof Error) throw next
          return next
        },
      },
    },
  }
  const catalog = client.createCatalog(ctx)

  responses.push({ ok: true, value: { groups: [], failures: [] } })
  await catalog.load(false)
  assert.equal(catalog.state.getSnapshot().status, 'empty', 'an empty catalog is not ready')

  responses.push({ ok: true, value: sampleCatalog })
  await catalog.load(false)
  assert.equal(catalog.state.getSnapshot().status, 'ready')
  assert.equal(catalog.state.getSnapshot().view.models, 4)

  let calls = 0
  ctx.remote.session.modelCatalog = async () => { calls += 1; return { ok: true, value: sampleCatalog } }
  await catalog.load(false)
  assert.equal(calls, 0, 'a ready catalog is served from memory')
  await catalog.load(true)
  assert.equal(calls, 1, 'an explicit refresh reads the Host again')

  ctx.remote.session.modelCatalog = async () => ({ ok: false, error: { message: 'session/unavailable' } })
  await catalog.load(true)
  assert.equal(catalog.state.getSnapshot().status, 'error')
  assert.equal(catalog.state.getSnapshot().error, 'session/unavailable')
})

test('createCatalog coalesces concurrent loads into one Host read', async () => {
  let calls = 0
  const ctx = {
    remote: {
      session: {
        modelCatalog: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return { ok: true, value: sampleCatalog } },
      },
    },
  }
  const catalog = client.createCatalog(ctx)
  await Promise.all([catalog.load(false), catalog.load(false), catalog.load(true)])
  assert.equal(calls, 1)
})

test('the tier form exposes the layout and roles switches, the main tier and both role routes', () => {
  react.__reset()
  const element = client.TierRoutingCard({
    t: (key) => key,
    view: 'edit',
    useTierRoutingCard: (select) => select({ writable: true }),
    useModelCatalog: (select) => select({ status: 'ready', view: client.catalogView(sampleCatalog), error: null }),
    loadCatalog() {}, refreshCatalog() {}, edit() {}, resetField() {}, save() {}, discard() {},
  })
  const fields = element.children.map((child) => child.props && (child.props.fieldKey || child.props.tier)).filter(Boolean)
  for (const key of ['threeTiers', 'mainFallback', 'rolesEnabled', 'main', 'advisor', 'reviewer', 'strong', 'cheap', 'subagentPolicy', 'spawnPolicy', 'forkPolicy', 'planMinExplore', 'planAdvisorGate', 'sidekickExplore', 'sidekickImplement', 'sidekickFix', 'advisorMaxCallsPerTurn', 'advisorConfirmTimeoutSec', 'forceTierOnExplicitModel', 'decisionModel', 'decisionBaseUrl', 'decisionPath', 'decisionApiKey', 'decisionStages', 'decisionApproveAt', 'decisionBlockAt', 'decisionTimeoutMs', 'decisionBudgetPerTurn', 'decisionCatalogPath', 'decisionCatalogQuery', 'promptProfile']) {
    assert.ok(fields.includes(key), 'form renders ' + key)
  }
})

test('the client declares every remote it reads (remote.session for the model catalog)', () => {
  assert.ok(client.inject.includes('remote.session'), 'reading ctx.remote.session without this inject fails at call time')
})

test('apply registers the form on the bundle and row seats, never on plugins.item', () => {
  const slots = []
  const keys = []
  const ctx = {
    locale: { bind: () => () => '', register() {} },
    configForms: {
      get: () => ({
        shell: () => ({}),
        field: () => ({}),
        bind: (f) => ({ ...f }),
        actions: () => ({}),
        dispose() {},
      }),
    },
    slots: {
      inject(name, fn) { slots.push(name); return fn() },
      register(options) { if (options.key) keys.push(options.key); return () => {} },
    },
    remote: {
      $on: () => () => {},
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) },
    },
    on: () => () => {},
    effect(fn) { return fn() },
  }
  // The real SettingsFormModel is a class; stub the form so apply can run.
  primitives.SettingsFormModel = class {
    constructor() {}
    bind(fn) { return { getSnapshot: fn, subscribe: () => () => {} } }
    actions() { return {} }
    shell() { return {} }
    field() { return {} }
    dispose() {}
  }
  const reloaded = loadClient()
  reloaded.apply(ctx)
  assert.ok(slots.includes('plugins.bundle.config'))
  assert.ok(slots.includes('plugins.row.config'))
  assert.ok(slots.includes('shell.overlay'))
  assert.ok(slots.includes('conversation.chat.commandview'))
  assert.ok(!slots.includes('plugins.item'), 'plugins.item belongs to the shipped official pages')
  assert.ok(keys.includes('dsh-tier-orchestrator'))
  assert.ok(keys.includes('dsh-tier-orchestrator#tier-routing'))
})

test('parseStageList reads JSON arrays and comma-separated lists, and drops unknown stages', () => {
  assert.deepEqual(client.parseStageList('["guard","consult"]'), ['guard', 'consult'])
  assert.deepEqual(client.parseStageList('guard, consult'), ['guard', 'consult'])
  assert.equal(client.parseStageList('guard, not-a-stage'), null, 'an unknown stage name is rejected, not dropped')
  assert.equal(client.parseStageList('foo'), null, 'a list of unknown stages is rejected')
  assert.deepEqual(client.parseStageList('guard,guard'), ['guard'], 'duplicates collapse')
  assert.deepEqual(client.parseStageList(''), [])
  assert.deepEqual(client.parseStageList('   '), [])
  assert.equal(client.parseStageList('["guard"'), null, 'malformed JSON is not a list')
  assert.equal(client.parseStageList('["guard", 5]'), null, 'a non-string entry is not a list')
})

test('the stage list field stages a JSON array and clears on an empty selection', () => {
  const spec = client.stageListField('decisionStages')
  assert.equal(spec.field, 'decisionStages')
  assert.equal(spec.format(['guard']), '["guard"]')
  assert.equal(spec.format([]), '')
  assert.deepEqual(spec.parse('["guard","consult"]'), { kind: 'set', value: ['guard', 'consult'] })
  assert.deepEqual(spec.parse('guard, consult'), { kind: 'set', value: ['guard', 'consult'] })
  assert.equal(spec.parse('guard, not-a-stage'), undefined, 'an unknown stage name is invalid')
  assert.equal(spec.parse('foo'), undefined)
  assert.deepEqual(spec.parse('[]'), { kind: 'clear' })
  assert.deepEqual(spec.parse(''), { kind: 'clear' })
  assert.equal(spec.parse('["guard"'), undefined, 'malformed JSON is invalid')
})

test('the bounded number field rejects out-of-range and fractional values', () => {
  const probability = client.boundedNumberField('decisionApproveAt', { min: 0, max: 1 })
  assert.deepEqual(probability.parse('0.9'), { kind: 'set', value: 0.9 })
  assert.deepEqual(probability.parse('0'), { kind: 'set', value: 0 })
  assert.deepEqual(probability.parse('1'), { kind: 'set', value: 1 })
  assert.equal(probability.parse('1.1'), undefined)
  assert.equal(probability.parse('-0.1'), undefined)
  assert.equal(probability.parse('abc'), undefined)
  assert.deepEqual(probability.parse(''), { kind: 'clear' })
  const timeout = client.boundedNumberField('decisionTimeoutMs', { min: 500, integer: true })
  assert.deepEqual(timeout.parse('8000'), { kind: 'set', value: 8000 })
  assert.equal(timeout.parse('499'), undefined)
  assert.equal(timeout.parse('100'), undefined, 'a timeout below the plugin clamp is rejected, not clamped')
  assert.deepEqual(timeout.parse('500'), { kind: 'set', value: 500 }, 'the clamp boundary is valid')
  assert.equal(timeout.parse('500.5'), undefined)
  assert.equal(timeout.parse('8000.5'), undefined)
  assert.deepEqual(timeout.parse('  '), { kind: 'clear' }, 'blank is a clear, not an invalid value')
  assert.equal(probability.parse('1.5'), undefined, 'a threshold above 1 is rejected, not clamped')
  assert.deepEqual(probability.parse('1e-1'), { kind: 'set', value: 0.1 }, 'scientific notation is a number')
})

test('the decision stages render as checkboxes and toggle the staged JSON list', () => {
  const edits = []
  const element = client.StagesField({
    t: (key) => key,
    state: { decisionStages: { text: '["guard"]' } },
    fieldKey: 'decisionStages',
    disabled: false,
    edit: (key, value) => edits.push([key, value]),
    resetField() {},
  })
  const labels = element.children.filter((child) => child && child.type === 'label')
  assert.equal(labels.length, 4, 'one checkbox per stage')
  const guard = labels.find((label) => label.props.key === 'guard')
  assert.equal(guard.children[0].props.checked, true)
  guard.children[0].props.onChange({})
  assert.deepEqual(edits, [['decisionStages', '[]']], 'clicking a selected stage clears it')
  const worker = labels.find((label) => label.props.key === 'worker')
  assert.equal(worker.children[0].props.checked, false)
  worker.children[0].props.onChange({})
  assert.deepEqual(edits[1], ['decisionStages', '["guard","worker"]'], 'clicking a free stage enables it')
})

test('every field the card renders is staged by the form', () => {
  react.__reset()
  const staged = new Set(client.SPECS.map((spec) => spec.field))
  const element = client.TierRoutingCard({
    t: (key) => key,
    view: 'edit',
    useTierRoutingCard: (select) => select({ writable: true }),
    useModelCatalog: (select) => select({ status: 'ready', view: client.catalogView(sampleCatalog), error: null }),
    loadCatalog() {}, refreshCatalog() {}, edit() {}, resetField() {}, save() {}, discard() {},
  })
  const rendered = element.children.map((child) => child.props && child.props.fieldKey).filter(Boolean)
  assert.ok(rendered.length > 20, 'the card renders its fields')
  for (const key of rendered) {
    assert.ok(staged.has(key), key + ' is rendered but no spec stages it')
  }
  for (const key of ['decisionModel', 'decisionBaseUrl', 'decisionPath', 'decisionApiKey', 'decisionStages', 'decisionApproveAt', 'decisionBlockAt', 'decisionTimeoutMs', 'decisionBudgetPerTurn', 'decisionCatalogPath', 'decisionCatalogQuery', 'promptProfile']) {
    assert.ok(staged.has(key), 'the form stages ' + key)
  }
})

test('the secret field masks the key, reveals it on demand and clears it explicitly', () => {
  react.__reset()
  const edits = []
  const props = {
    t: (key) => key,
    state: { decisionApiKey: { text: 'sk-secret' } },
    fieldKey: 'decisionApiKey',
    labelKey: 'decisionApiKey',
    hintKey: 'decisionApiKeyHint',
    disabled: false,
    edit: (key, value) => edits.push([key, value]),
    resetField() {},
  }
  const element = client.SecretField(props)
  const input = element.children.find((child) => child && child.type === 'input')
  assert.equal(input.props.type, 'password', 'the key is masked by default')
  assert.equal(input.props.value, 'sk-secret')
  const buttons = element.children[0].children[3].children.filter(Boolean)
  assert.equal(buttons.length, 2, 'show and clear, no reset while untouched')
  const show = buttons[0]
  assert.equal(show.children[0], 'showSecret')
  show.props.onClick()
  const revealed = client.SecretField(props).children.find((child) => child && child.type === 'input')
  assert.equal(revealed.props.type, 'text', 'the key can be revealed')
  const clear = buttons[1]
  assert.equal(clear.children[0], 'apiKeyClear')
  clear.props.onClick()
  assert.deepEqual(edits, [['decisionApiKey', '']], 'clearing is an explicit act')
})

test('the secret field stages nothing until the user touches it', () => {
  react.__reset()
  const edits = []
  client.SecretField({
    t: (key) => key,
    state: { decisionApiKey: { text: 'sk-secret' } },
    fieldKey: 'decisionApiKey',
    labelKey: 'decisionApiKey',
    hintKey: 'decisionApiKeyHint',
    disabled: false,
    edit: (key, value) => edits.push([key, value]),
    resetField() {},
  })
  assert.deepEqual(edits, [], 'an untouched key is never staged, so a save cannot rewrite it')
})

test('a host that masks the stored key is reported, not shown as a real key', () => {
  react.__reset()
  const element = client.SecretField({
    t: (key) => key,
    state: { decisionApiKey: { text: '***' } },
    fieldKey: 'decisionApiKey',
    labelKey: 'decisionApiKey',
    hintKey: 'decisionApiKeyHint',
    disabled: false,
    edit() {}, resetField() {},
  })
  const input = element.children.find((child) => child && child.type === 'input')
  assert.equal(input.props.value, '', 'a masked value is never put into the field')
  assert.equal(input.props.placeholder, 'apiKeyHidden')
  assert.equal(client.isHiddenSecret('***'), true)
  assert.equal(client.isHiddenSecret('REDACTED'), true)
  assert.equal(client.isHiddenSecret('sk-secret'), false)
  assert.equal(client.isHiddenSecret('sk-***-abc'), false, 'the match is exact, a real key is not hidden')
  assert.equal(client.isHiddenSecret('sk-redacted-abc'), false)
  assert.equal(client.isHiddenSecret(''), false)
})

test('the stage field survives a malformed staged list', () => {
  react.__reset()
  const edits = []
  const element = client.StagesField({
    t: (key) => key,
    state: { decisionStages: { text: '["guard"' } },
    fieldKey: 'decisionStages',
    disabled: false,
    edit: (key, value) => edits.push([key, value]),
    resetField() {},
  })
  const labels = element.children.filter((child) => child && child.type === 'label')
  assert.equal(labels.length, 4)
  for (const label of labels) assert.equal(label.children[0].props.checked, false, 'nothing is checked')
  labels[0].children[0].props.onChange({})
  assert.deepEqual(edits, [['decisionStages', '["guard"]']], 'the first click rewrites a valid list')
})

test('the decision status warns about stages without a model and about an inverted threshold', () => {
  react.__reset()
  const element = client.DecisionStatus({
    t: (key) => key,
    state: {
      decisionModel: { text: '' },
      decisionStages: { text: '["guard"]' },
      decisionApproveAt: { text: '0.2' },
      decisionBlockAt: { text: '0.5' },
    },
  })
  const lines = element.children.map((child) => child && child.children && child.children[0])
  assert.ok(lines.includes('decisionStagesWithoutModel'))
  assert.ok(lines.includes('decisionThresholdOrder'))
})

test('a text field shows the invalid hint of its own field kind', () => {
  react.__reset()
  const state = { decisionApproveAt: { text: '1.5' } }
  const element = client.TextField({
    t: (key) => key,
    state,
    fieldKey: 'decisionApproveAt',
    labelKey: 'decisionApproveAt',
    hintKey: 'decisionApproveAtHint',
    invalidKey: 'invalidProbability',
    edit() {}, resetField() {},
  })
  assert.equal(element.props.invalidLabel, 'invalidProbability')
  const plain = client.TextField({
    t: (key) => key,
    state,
    fieldKey: 'decisionApproveAt',
    labelKey: 'decisionApproveAt',
    hintKey: 'decisionApproveAtHint',
    edit() {}, resetField() {},
  })
  assert.equal(plain.props.invalidLabel, 'invalid', 'the other fields keep the generic hint')
})

test('the English and Chinese dictionaries carry the same keys', () => {
  const en = Object.keys(client.locales.en).sort()
  const zh = Object.keys(client.locales.zh).sort()
  assert.deepEqual(en, zh, 'a key exists in one dictionary only')
  for (const key of ['decisionSection', 'decisionModel', 'decisionApiKey', 'decisionStages', 'decisionApproveAt', 'decisionBlockAt', 'decisionTimeoutMs', 'decisionBudgetPerTurn', 'decisionCatalogPath', 'decisionCatalogQuery', 'promptProfile']) {
    assert.ok(en.includes(key), 'the locale has ' + key)
  }
})

test('the prompt profile values of the form match the plugin schema', () => {
  // The schema is the source of truth: read the values it allows.
  const union = Config.dict.promptProfile
  const allowed = union.list.map((entry) => (entry && typeof entry.value === 'string' ? entry.value : ''))
  assert.deepEqual(allowed, ['standard', 'pi'])
  const spec = client.SPECS.find((entry) => entry.field === 'promptProfile')
  assert.ok(spec, 'the form stages the prompt profile')
  for (const value of allowed) {
    assert.deepEqual(spec.parse(value), { kind: 'set', value }, 'the form accepts ' + value)
  }
  assert.equal(spec.parse('other'), undefined)
})

test('a masked key never reaches the staged text', () => {
  const spec = client.secretField('decisionApiKey')
  assert.equal(spec.format('***'), '', 'a mask is not shown as the stored value')
  assert.equal(spec.format('REDACTED'), '')
  assert.equal(spec.format('sk-secret'), 'sk-secret')
  assert.equal(spec.parse('***'), undefined, 'a mask is never staged as a value')
  assert.deepEqual(spec.parse(''), { kind: 'clear' })
  assert.deepEqual(spec.parse('sk-secret'), { kind: 'set', value: 'sk-secret' })
})

test('the stage field reports a malformed staged list', () => {
  react.__reset()
  const element = client.StagesField({
    t: (key) => key,
    state: { decisionStages: { text: '["guard"' } },
    fieldKey: 'decisionStages',
    disabled: false,
    edit() {}, resetField() {},
  })
  const lines = element.children.map((child) => child && child.children && child.children[0])
  assert.ok(lines.includes('invalidStages'), 'the malformed list is reported')
})

test('the decision status reports a plain-text endpoint', () => {
  react.__reset()
  const element = client.DecisionStatus({
    t: (key) => key,
    state: {
      decisionModel: { text: 'jevens/jev-1.5' },
      decisionStages: { text: '["guard"]' },
      decisionApproveAt: { text: '0.9' },
      decisionBlockAt: { text: '0.1' },
      decisionBaseUrl: { text: 'http://decision.local' },
    },
  })
  const lines = element.children.map((child) => child && child.children && child.children[0])
  assert.ok(lines.includes('decisionInsecureEndpoint'))
  const secure = client.DecisionStatus({
    t: (key) => key,
    state: {
      decisionModel: { text: 'jevens/jev-1.5' },
      decisionStages: { text: '["guard"]' },
      decisionApproveAt: { text: '0.9' },
      decisionBlockAt: { text: '0.1' },
      decisionBaseUrl: { text: 'https://openrouter.ai' },
    },
  })
  const secureLines = secure.children.map((child) => child && child.children && child.children[0])
  assert.ok(!secureLines.includes('decisionInsecureEndpoint'))
})

test('the stage labels the checkboxes render exist in both dictionaries', () => {
  for (const stage of client.DECISION_STAGES) {
    const key = 'decisionStage' + stage.charAt(0).toUpperCase() + stage.slice(1)
    assert.ok(Object.prototype.hasOwnProperty.call(client.locales.en, key), 'en has ' + key)
    assert.ok(Object.prototype.hasOwnProperty.call(client.locales.zh, key), 'zh has ' + key)
  }
})

test('the card renders the decision models from the decision catalog, not the chat one', () => {
  react.__reset()
  const element = client.TierRoutingCard({
    t: (key) => key,
    view: 'edit',
    useTierRoutingCard: (select) => select({ writable: true }),
    useModelCatalog: (select) => select({ status: 'ready', view: client.catalogView(sampleCatalog), error: null }),
    useDecisionCatalog: (select) => select({ status: 'ready', view: client.decisionCatalogView(sampleDecisionCatalog), error: null }),
    loadCatalog() {}, refreshCatalog() {}, edit() {}, resetField() {}, save() {}, discard() {},
    loadDecisionCatalog() {},
  })
  const decisionField = element.children.find((child) => child.props && child.props.fieldKey === 'decisionModel')
  assert.ok(decisionField, 'the card renders the decision model field')
  // The card's children are component elements: render this one the way React would.
  const rendered = decisionField.type(decisionField.props)
  const select = rendered.children.find((child) => child && child.type === 'select')
  assert.ok(select, 'a ready decision catalog makes a dropdown')
  const values = select.children.filter(Boolean).map((option) => option.props.value)
  assert.ok(values.includes('typesafe/jev-1.14'), 'the decision models are offered')
  assert.ok(!values.includes('deepseek/deepseek-v4-flash'), 'a chat model from the other catalog is not offered')
})

test('the decision picker shows a disabled dropdown while the catalog loads', () => {
  react.__reset()
  const element = client.DecisionModelField({
    t: (key) => key,
    state: { decisionModel: { text: '' } },
    fieldKey: 'decisionModel',
    catalog: { status: 'loading', view: client.decisionCatalogView(undefined), error: null },
    disabled: false,
    customOn: false,
    onToggleCustom() {},
    edit() {}, resetField() {}, refreshCatalog() {},
  })
  const select = element.children.find((child) => child && child.type === 'select')
  assert.ok(select, 'the dropdown is coming, not a text box')
  assert.equal(select.props.disabled, true, 'it waits for the list')
  const status = element.children.find((child) => child && child.type === 'div' && child.children && child.children[0] && child.children[0].children && child.children[0].children[0] === 'decisionCatalogLoading')
  assert.ok(status, 'the loading status is shown')
})

test('the decision field prefers the decision catalog when both are passed', () => {
  react.__reset()
  const element = client.DecisionModelField({
    t: (key) => key,
    state: { decisionModel: { text: '' } },
    fieldKey: 'decisionModel',
    catalog: client.catalogView(sampleCatalog),
    decisionCatalog: { status: 'ready', view: client.decisionCatalogView(sampleDecisionCatalog), error: null },
    disabled: false,
    customOn: false,
    onToggleCustom() {},
    edit() {}, resetField() {}, refreshCatalog() {},
  })
  assert.ok(element.children.some((child) => child && child.type === 'select'), 'the decision catalog wins')
})

test('the decision catalog keeps the models that answer with decisions', () => {
  const view = client.decisionCatalogView(sampleDecisionCatalog)
  const ids = view.models.map((m) => m.id)
  assert.deepEqual(ids, ['typesafe/jev-1.14', 'cloudflare/clef', 'custom/decision-x', 'custom/no-shape', 'custom/router'])
  assert.equal(view.count, 5)
  assert.equal(view.models[0].name, 'TypeSafe: Jev 1.14')
  assert.equal(view.models[0].pricePerMTok, 0.042, 'the price is per million tokens')
  assert.equal(view.models[0].contextLength, 262144)
  assert.equal(view.models[1].pricePerMTok, 0.24)
  assert.equal(view.models[4].pricePerMTok, null, 'a router has no per-token price')
  assert.equal(view.models[2].pricePerMTok, null, 'a model without a price says nothing')
})

test('the decision catalog reads the other catalog shapes and tolerates garbage', () => {
  assert.equal(client.decisionCatalogView({ models: [{ id: 'a' }] }).count, 1)
  assert.equal(client.decisionCatalogView([{ id: 'a' }]).count, 1)
  assert.equal(client.decisionCatalogView({ data: [] }).count, 0)
  assert.equal(client.decisionCatalogView(undefined).count, 0)
  assert.equal(client.decisionCatalogView({ data: 'nope' }).count, 0)
})

test('the decision catalog URL follows the endpoint, path and query', () => {
  assert.equal(
    client.decisionCatalogUrl({ baseUrl: '', path: '', query: '' }),
    'https://openrouter.ai/api/v1/models?output_modalities=decisions&limit=100',
    'the OpenRouter catalog is filtered by default')
  assert.equal(
    client.decisionCatalogUrl({ baseUrl: 'https://decision.local', path: '/v2/models', query: '' }),
    'https://decision.local/v2/models',
    'another endpoint keeps the query it was given')
  assert.equal(
    client.decisionCatalogUrl({ baseUrl: '', path: '', query: 'output_modalities=decisions&limit=100' }),
    'https://openrouter.ai/api/v1/models?output_modalities=decisions&limit=100')
  assert.equal(
    client.decisionCatalogUrl({ baseUrl: 'https://decision.local/', path: '/v2/models', query: '?all=1' }),
    'https://decision.local/v2/models?all=1')
})

test('the decision catalog reads the list once and refreshes on demand', async () => {
  const calls = []
  const catalog = client.createDecisionCatalog(async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, json: async () => sampleDecisionCatalog }
  })
  await catalog.load({ baseUrl: '', path: '', query: '' })
  const snapshot = catalog.state.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.view.count, 5)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models?output_modalities=decisions&limit=100')
  assert.equal(calls[0].opts.headers.authorization, undefined, 'the catalog is public: no key is sent')

  await catalog.load({ baseUrl: '', path: '', query: '' })
  assert.equal(calls.length, 1, 'a ready catalog is served from memory')

  await catalog.load({ baseUrl: '', path: '', query: '' }, true)
  assert.equal(calls.length, 2, 'a refresh reads the host again')

  await catalog.load({ baseUrl: 'https://decision.local', path: '/v2/models', query: '' })
  assert.equal(calls.length, 3, 'a changed endpoint is read again')
  assert.equal(calls[2].url, 'https://decision.local/v2/models')
})

test('the decision catalog reports an empty list and a failed read', async () => {
  const empty = client.createDecisionCatalog(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }))
  await empty.load({})
  assert.equal(empty.state.getSnapshot().status, 'empty')

  const failed = client.createDecisionCatalog(async () => { throw new Error('offline') })
  await failed.load({})
  const snapshot = failed.state.getSnapshot()
  assert.equal(snapshot.status, 'error')
  assert.equal(snapshot.error, 'offline')

  const httpError = client.createDecisionCatalog(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  await httpError.load({})
  assert.equal(httpError.state.getSnapshot().status, 'error')
  assert.match(httpError.state.getSnapshot().error, /500/)
})

test('the decision model is picked from the catalog and falls back to text', () => {
  react.__reset()
  const edits = []
  const catalog = { status: 'ready', view: client.decisionCatalogView(sampleDecisionCatalog), error: null }
  const element = client.DecisionModelField({
    t: (key) => key,
    state: { decisionModel: { text: 'typesafe/jev-1.14' } },
    fieldKey: 'decisionModel',
    catalog,
    disabled: false,
    customOn: false,
    onToggleCustom() {},
    edit: (key, value) => edits.push([key, value]),
    resetField() {},
    refreshCatalog() {},
  })
  const select = element.children.find((child) => child && child.type === 'select')
  assert.ok(select, 'the catalog is a dropdown')
  const values = select.children.filter(Boolean).map((option) => option.props.value)
  assert.ok(values.includes('typesafe/jev-1.14'))
  assert.ok(values.includes('cloudflare/clef'))
  assert.ok(!values.includes('deepseek/deepseek-v4-flash'), 'a chat model is not offered')
  select.props.onChange({ target: { value: 'cloudflare/clef' } })
  assert.deepEqual(edits, [['decisionModel', 'cloudflare/clef']])

  react.__reset()
  const text = client.DecisionModelField({
    t: (key) => key,
    state: { decisionModel: { text: 'typesafe/jev-1.14' } },
    fieldKey: 'decisionModel',
    catalog: { status: 'empty', view: client.decisionCatalogView(undefined), error: null },
    disabled: false,
    customOn: false,
    onToggleCustom() {},
    edit() {}, resetField() {}, refreshCatalog() {},
  })
  const input = text.children.find((child) => child && child.type === 'input')
  assert.ok(input, 'without a catalog the model stays free text')
  assert.equal(input.props.value, 'typesafe/jev-1.14')
})

test('the catalog follows the endpoint when it changes while a read is running', async () => {
  const calls = []
  let release = null
  const catalog = client.createDecisionCatalog(async (url) => {
    calls.push(url)
    if (calls.length === 1) await new Promise((resolve) => { release = resolve })
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a/' + calls.length, architecture: { output_modalities: ['decisions'] } }] }) }
  })
  const first = catalog.load({ baseUrl: 'https://one.local', path: '/m', query: '' })
  const second = catalog.load({ baseUrl: 'https://two.local', path: '/m', query: '' })
  release()
  await Promise.all([first, second])
  await new Promise((resolve) => setTimeout(resolve, 10))
  const snapshot = catalog.state.getSnapshot()
  assert.equal(snapshot.url, 'https://two.local/m', 'the newest endpoint wins')
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.view.models[0].id, 'a/2', 'the stale answer never landed')
  assert.equal(calls.length, 2)
})

test('a model the catalog did not confirm is marked as unverified', () => {
  react.__reset()
  const element = client.DecisionModelField({
    t: (key) => key,
    state: { decisionModel: { text: '' } },
    fieldKey: 'decisionModel',
    catalog: { status: 'ready', view: client.decisionCatalogView(sampleDecisionCatalog), error: null },
    disabled: false,
    customOn: false,
    onToggleCustom() {},
    edit() {}, resetField() {}, refreshCatalog() {},
  })
  const select = element.children.find((child) => child && child.type === 'select')
  const labels = select.children.filter(Boolean).map((option) => option.children[0])
  assert.ok(labels.some((label) => String(label).includes('decisionModelUnverified')), 'an unconfirmed model says so')
  assert.ok(labels.some((label) => !String(label).includes('decisionModelUnverified')), 'a confirmed model does not')
  const view = client.decisionCatalogView(sampleDecisionCatalog)
  assert.equal(view.models[0].verified, true)
  assert.equal(view.models[3].verified, false, 'an entry without the modality is unconfirmed')
})

test('a decision model that the catalog does not list is kept', () => {
  react.__reset()
  const element = client.DecisionModelField({
    t: (key) => key,
    state: { decisionModel: { text: 'self-hosted/jev-9' } },
    fieldKey: 'decisionModel',
    catalog: { status: 'ready', view: client.decisionCatalogView(sampleDecisionCatalog), error: null },
    disabled: false,
    customOn: false,
    onToggleCustom() {},
    edit() {}, resetField() {}, refreshCatalog() {},
  })
  const select = element.children.find((child) => child && child.type === 'select')
  const values = select.children.filter(Boolean).map((option) => option.props.value)
  assert.ok(values.includes('self-hosted/jev-9'), 'the stored value stays selectable')
})

test('the client stage list matches the core stage list', () => {
  assert.deepEqual(client.DECISION_STAGES, CORE_DECISION_STAGES)
})

