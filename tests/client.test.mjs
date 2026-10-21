// Browser-half checks for client/client.js. The bundle is a classic script that
// registers a ModuleLoader factory; the factory is evaluated here against
// stubbed `react` and primitives so the real module code runs under node.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const primitives = {
  settingsTextField: (field) => ({ field, format: () => '', parse: () => undefined }),
  settingsNumberField: (field) => ({ field, format: () => '', parse: () => undefined }),
  SettingsValueField() {},
  SettingsForm() {},
  SettingsFormModel: class {},
}
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
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
  const element = client.TierRoutingCard({
    t: (key) => key,
    view: 'edit',
    useTierRoutingCard: (select) => select({ writable: true }),
    useModelCatalog: (select) => select({ status: 'ready', view: client.catalogView(sampleCatalog), error: null }),
    loadCatalog() {}, refreshCatalog() {}, edit() {}, resetField() {}, save() {}, discard() {},
  })
  const fields = element.children.map((child) => child.props && (child.props.fieldKey || child.props.tier)).filter(Boolean)
  for (const key of ['threeTiers', 'mainFollowSession', 'mainFallback', 'rolesEnabled', 'main', 'advisor', 'reviewer', 'strong', 'cheap', 'subagentPolicy', 'spawnPolicy', 'forkPolicy', 'planMinExplore', 'planAdvisorGate', 'sidekickExplore', 'sidekickImplement', 'sidekickFix', 'advisorMaxCallsPerTurn', 'advisorConfirmTimeoutSec', 'forceTierOnExplicitModel']) {
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
  assert.ok(keys.includes('dsh-tier-router'))
  assert.ok(keys.includes('dsh-tier-router#tier-routing'))
})
