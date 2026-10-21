// Runtime smoke test: loads the real bundle against a mocked DSH 0.2.x
// context, runs apply() on the agent plane, and exercises every tool/command/
// listener path — the agent/request waterfall seam, settings-backed
// persistence, startActivation subagents, fallback chains, task-intensity
// effort, explicit tier config, effort validation.
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const SESSION_DEFAULT = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }

function makeAgent(id, origin, options = {}) {
  const writes = []
  const session = {
    id: 'session-' + id,
    header: { origin: origin || '' },
    events: [],
    append(kind, payload) { writes.push({ kind, payload }) },
    requestHeader() {
      const last = writes.filter((w) => w.kind === 'request/header').at(-1)
      return last ? last.payload.header : null
    },
  }
  return { id, options: { provider: options.provider || 'deepseek-official', model: options.model || 'deepseek-v4-pro', reasoningEffort: options.reasoningEffort || 'max', ...options }, session, writes }
}

// Simulates one loop pass through the `agent/request` waterfall: next()
// yields the seed config (the session default / logged header); the listener
// returns the routed replacement or the seed unchanged.
async function runRequest(ctx, agent, seed) {
  const fn = (ctx.listeners['agent/request'] || [])[0]
  assert.ok(fn, 'agent/request listener is registered')
  return fn({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => seed || { ...SESSION_DEFAULT })
}

function makeContext(options = {}) {
  const childAgents = new Map()
  const ctx = {
    listeners: {},
    on(name, fn) {
      ;(ctx.listeners[name] || (ctx.listeners[name] = [])).push(fn)
    },
    get(name) { return ctx.services[name] },
    emit(name, ...args) {
      for (const fn of ctx.listeners[name] || []) fn(...args)
    },
  }
  const services = {
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }, { id: 'opencode-go' }, { id: 'cctq' }],
      listModels: async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }, { id: 'gpt-5.6-terra' }],
      resolveModelInfo: async (provider, model) => {
        if (typeof options.modelInfo === 'function') {
          const custom = await options.modelInfo(provider, model)
          if (custom !== undefined) return custom
        }
        const efforts = provider === 'cctq' ? ['low', 'medium', 'high'] : ['off', 'high', 'max']
        return { provider, id: model, name: model, reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } }
      },
      stream: async function* (options) {
        services.llm.lastStreamOptions = options
        yield { type: 'text-delta', text: 'MOCK ADVICE' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tools: { registered: [], register(tool) { this.registered.push(tool) } },
    commands: { registered: [], register(cmd) { this.registered.push(cmd) } },
    planMode: { get: () => ({ active: false }), set: () => 'committed' },
    agentDefaultModel: {
      saved: [],
      currentSelection: () => ({ ...SESSION_DEFAULT }),
      saveSelection: async function (sel) { services.agentDefaultModel.saved.push(sel) },
    },
    systemPrompt: { sections: [], section(s) { this.sections.push(s) } },
    subagents: {
      list: () => ['spawn'],
      started: [],
      async startActivation(spec) {
        const localAgent = makeAgent('worker-' + this.started.length, 'subagent')
        childAgents.set(localAgent.session.id, localAgent)
        this.started.push(spec)
        return {
          childId: localAgent.session.id,
          result: Promise.resolve({
            output: [{ type: 'text', text: Array.isArray(options.workerResults) && options.workerResults.length
              ? options.workerResults.shift()
              : (options.workerResult ?? 'worker-ok') }],
            stopReason: 'stop',
          }),
          dispose: async () => {},
        }
      },
    },
    agents: {
      known: new Map(),
      get(id) { return this.known.get(id) || childAgents.get(id) || null },
      register(agent) { this.known.set(agent.session.id, agent) },
    },
    settings: {
      updates: [],
      describe() {
        return [{
          ns: 'tier-routing',
          value: {
            ...(options.omitMode ? {} : { mode: options.mode || 'auto' }),
            strongProvider: 'deepseek-official',
            strongModel: 'deepseek-v4-pro',
            strongEffort: 'max',
            strongFallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }],
            cheapProvider: options.cheapProvider || 'cctq',
            cheapModel: options.cheapModel || 'gpt-5.6-terra',
            cheapEffort: options.cheapEffort || 'medium',
            cheapFallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }],
            subagentPolicy: 'inherit',
          },
        }]
      },
      async update(ns, patch) { this.updates.push({ ns, patch }) },
    },
    jobs: {
      controllers: [],
      hooks: null,
      attachController(name) { this.controllers.push(name) },
      start(spec) {
        this.lastSpec = spec
        this.hooks = spec.run({})
        return 'subagent-1'
      },
    },
    approval: {
      requests: [],
      outcome: options.approvalOutcome ?? 'allowed-once',
      async request(req) { this.requests.push(req); return this.outcome },
    },
    fs: options.fs ? {
      files: new Map((options.fs.files || []).map(([p, v]) => [p, v])),
      calls: [],
      async resolve(p, opts) {
        this.calls.push(['resolve', p])
        return { key: String((opts && opts.cwd) || '') + '/' + p, displayPath: p }
      },
      async readText(target) {
        this.calls.push(['readText', target.displayPath])
        const v = this.files.get(target.displayPath)
        if (v === undefined) throw new Error('FS_NOT_FOUND')
        if (typeof v !== 'string') throw new Error('FS_NOT_TEXT')
        return v
      },
      async writeText(target, text) {
        this.calls.push(['writeText', target.displayPath])
        this.files.set(target.displayPath, text)
      },
    } : undefined,
  }
  ctx.services = services
  return { ctx, services, childAgents }
}

function applyAgent(ctx) {
  apply(ctx, { plane: 'agent' })
}

test('apply() registers every surface and mounts the agent/request seam', () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const names = services.tools.registered.map((t) => t.name).sort()
  assert.deepEqual(names, ['tier_advisor', 'tier_configure', 'tier_escalate_effort', 'tier_review', 'tier_route', 'tier_sidekick', 'tier_status', 'tier_worker'])
  assert.deepEqual(services.commands.registered.map((c) => c.name).sort(), ['advisor', 'tier'])
  assert.equal(services.systemPrompt.sections.length, 1)
  assert.equal(services.systemPrompt.sections[0].name, 'tier-routing')
  assert.ok(services.systemPrompt.sections[0].text().includes('Tiered model routing'))
  assert.ok(services.jobs.controllers.includes('tier-worker'), 'jobs controller attached')
  for (const event of ['agent/request', 'agent/inbox/inserted', 'session/event', 'agent/error', 'agent/request-error', 'tools/pre-execute']) {
    assert.ok(ctx.listeners[event] && ctx.listeners[event].length >= 1, 'listener registered for ' + event)
  }
})

test('host plane mounts nothing but stays silent-healthy', () => {
  const { ctx, services } = makeContext()
  apply(ctx, { plane: 'host' })
  assert.equal(services.tools.registered.length, 0)
  assert.equal(Object.keys(ctx.listeners).length, 0)
})

test('persisted settings without a mode retain the auto default', async () => {
  const { ctx, services } = makeContext({ omitMode: true })
  applyAgent(ctx)
  const main = makeAgent('main')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('mode: global=auto, this session=auto'), out.status)
})

test('waterfall routing switches each request to the cheap tier in auto mode', async () => {
  const { ctx } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const out = await runRequest(ctx, main)
  assert.deepEqual({ provider: out.provider, model: out.model, reasoningEffort: out.reasoningEffort }, { provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
})

test('waterfall keeps unrelated seed fields intact', async () => {
  const { ctx } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const out = await runRequest(ctx, main, { ...SESSION_DEFAULT, maxTokens: 8192, stop: ['END'] })
  assert.equal(out.maxTokens, 8192)
  assert.deepEqual(out.stop, ['END'])
})

test('fits an undeclared effort onto the model declaration before the request', async () => {
  // deepseek-v4-flash declares off/low/high/max — no medium, which used to
  // fail every cheap-tier request with UNSUPPORTED_REASONING_EFFORT.
  const { ctx } = makeContext({
    cheapProvider: 'deepseek-official',
    cheapModel: 'deepseek-v4-flash',
    cheapEffort: 'medium',
    modelInfo: async (provider, model) => (provider === 'deepseek-official' && model === 'deepseek-v4-flash'
      ? { provider, id: model, name: model, reasoning: { efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id, name: id })) } }
      : undefined),
  })
  applyAgent(ctx)
  const main = makeAgent('main')
  const out = await runRequest(ctx, main)
  assert.equal(out.model, 'deepseek-v4-flash')
  assert.equal(out.reasoningEffort, 'low', 'medium is fitted to the lowest declared effort')
})

test('omits reasoningEffort for a route that declares no reasoning support', async () => {
  const { ctx } = makeContext({
    cheapProvider: 'openrouter',
    cheapModel: 'minimax/minimax-m3.1-flash',
    cheapEffort: 'medium',
    modelInfo: async (provider, model) => (provider === 'openrouter'
      ? { provider, id: model, name: model }
      : undefined),
  })
  applyAgent(ctx)
  const main = makeAgent('main')
  const out = await runRequest(ctx, main)
  assert.equal(out.model, 'minimax/minimax-m3.1-flash')
  assert.ok(!('reasoningEffort' in out), 'no effort may ride a model without reasoning metadata')
})

test('tier_route applies per-session mode visible on the next request', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  const out = await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  assert.equal(out.applied, 'cheap')
  assert.ok(!out.message.includes('Saved as the session default'), 'persist defaults to false')
  const req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra')
  assert.equal(req.reasoningEffort, 'medium')
})

test('off mode restores the baseline session model', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  let req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra')
  await route.execute({ tier: 'off' }, { agent: main, signal: undefined })
  req = await runRequest(ctx, main, { provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
  assert.equal(req.model, 'deepseek-v4-pro', 'off restores the captured baseline, not the last routed config')
})

test('delegated mode keeps the main agent on its baseline while children tier', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const main = makeAgent('main', undefined, { provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'delegated' }, { agent: main, signal: undefined })
  // baseline captured at the delegated-switch call (agent options)
  const req = await runRequest(ctx, main, { provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  assert.equal(req.model, 'gpt-5.6-sol', 'delegated main is not tier-routed')
  // plan flip does not reroute the delegated main
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  const req2 = await runRequest(ctx, main, { provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  assert.equal(req2.model, 'gpt-5.6-sol')
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'boom 1' } })
    await fn({ agent: main, error: { message: 'boom 2' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const mainStatus = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(!mainStatus.status.includes('(ESCALATED to strong)'), mainStatus.status)
  const child = makeAgent('child', 'subagent')
  const childStatus = await status.execute({}, { agent: child, signal: undefined })
  assert.ok(childStatus.status.includes('effective tier for calling agent: cheap'), childStatus.status)
})

test('session auto overrides delegated mode and restores plan-aware main routing', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'delegated' }, { agent: main, signal: undefined })
  await route.execute({ tier: 'auto' }, { agent: main, signal: undefined })
  const req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra', 'auto routes execution to the cheap tier')
})

test('explicit per-session mode does not follow plan flips', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  main.session.events.push({ type: 'plan/mode', data: { active: true } })
  const req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra', 'cheap session must NOT flip to strong on plan entry')
})

test('auto mode follows the plan/mode fold per request', async () => {
  const { ctx } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  let req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra')
  main.session.events.push({ type: 'plan/mode', data: { active: true } })
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-pro', 'plan mode routes strong (explicit config)')
  main.session.events.push({ type: 'plan/mode', data: { active: false } })
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra')
})

test('strong uses its explicit config, never the session picker', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  const req = await runRequest(ctx, main)
  assert.deepEqual({ provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort }, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }, 'strong must use the plugin config, not the session selection')
})

test('ordinary child requests apply the subagent policy', async () => {
  const { ctx } = makeContext()
  applyAgent(ctx)
  const child = makeAgent('child', 'subagent')
  const req = await runRequest(ctx, child)
  assert.equal(req.model, 'gpt-5.6-terra')
})

test('failure escalation covers built-in-subagent children', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const child = makeAgent('child', 'subagent')
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: child, error: { message: 'boom 1' } })
    await fn({ agent: child, error: { message: 'boom 2' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: child, signal: undefined })
  assert.ok(out.status.includes('effective tier for calling agent: strong'), 'escalated child resolves to strong')
  const req = await runRequest(ctx, child)
  assert.equal(req.model, 'deepseek-v4-pro', 'escalation routes the child retry to the strong tier')
  assert.ok(out.status.includes('(ESCALATED to strong)'))
})

test('fallback chain routes the retry and is kept until TTL', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  for (const fn of ctx.listeners['agent/request-error']) {
    const action = await fn({ agent: main, failure: { message: 'unknown model', code: 'UNKNOWN_MODEL' } }, async () => undefined)
    assert.deepEqual(action, { kind: 'retry' })
  }
  const req = await runRequest(ctx, main)
  assert.deepEqual({ provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort }, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }, 'cheap falls back to its chain entry')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('fallback state: tier=cheap index=0/1'), out.status)
  assert.ok(out.status.includes('cheap effort: medium'), 'successful fallback retry does not raise cheap effort: ' + out.status)
})

test('mode switches clear per-agent fallback state', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  for (const fn of ctx.listeners['agent/request-error']) {
    await fn({ agent: main, failure: { message: 'quota', code: 'QUOTA' } }, async () => undefined)
  }
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const req = await runRequest(ctx, main)
  assert.deepEqual({ provider: req.provider, model: req.model }, { provider: 'cctq', model: 'gpt-5.6-terra' }, 'primary model is used again after a mode switch')
})

test('chain exhaustion clears fallback state and lets escalation take over', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  // burn the single cheap chain entry through request-error
  for (const fn of ctx.listeners['agent/request-error']) {
    await fn({ agent: main, failure: { message: 'unknown model', code: 'UNKNOWN_MODEL' } }, async () => undefined)
    await fn({ agent: main, failure: { message: 'unknown model again', code: 'UNKNOWN_MODEL' } }, async () => undefined)
  }
  // two counted errors escalate via agent/error
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'unknown model', code: 'UNKNOWN_MODEL' } })
    await fn({ agent: main, error: { message: 'unknown model again', code: 'UNKNOWN_MODEL' } })
  }
  const req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-pro', 'escalation takes over after the chain is exhausted')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('main model (no fallback active)'), out.status)
  assert.ok(out.status.includes('ESCALATED to strong'), out.status)
})

test('cheap effort ladder raises on cheap-tier retry errors', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'timeout', code: 'TIMEOUT' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('cheap effort: high'), out.status)
})

test('guard denials raise the cheap effort', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const guard = ctx.listeners['tools/pre-execute'][0]
  const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => {})
  assert.equal(result.kind, 'deny')
  assert.ok(result.reason.includes('raised to high'), result.reason)
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('cheap effort: high'), out.status)
})

test('tier_escalate_effort raises one step and respects the model ceiling', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const tool = services.tools.registered.find((t) => t.name === 'tier_escalate_effort')
  const r1 = await tool.execute({}, { agent: main, signal: undefined })
  assert.equal(r1.ok, true)
  assert.equal(r1.effort, 'high')
  const r2 = await tool.execute({}, { agent: main, signal: undefined })
  assert.equal(r2.ok, false, 'cctq declares only low/medium/high')
  assert.ok(r2.message.includes('declares only'), r2.message)
})

test('/tier delegated switches the current session and /tier auto leaves it', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const delegated = await cmd.handler({ agent: main, rawInput: 'delegated', signal: undefined })
  assert.equal(delegated.kind, 'success')
  assert.ok(delegated.text.includes('only subagents are tier-routed'), delegated.text)
  const status = await cmd.handler({ agent: main, rawInput: 'status', signal: undefined })
  assert.ok(status.text.includes('this session=delegated'), status.text)
  const auto = await cmd.handler({ agent: main, rawInput: 'auto', signal: undefined })
  assert.equal(auto.kind, 'success')
  assert.ok(auto.text.includes('plan mode -> strong tier'), auto.text)
})

test('/tier set parses fallback chains and rejects follow-session tokens', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r1 = await cmd.handler({ agent: main, rawInput: 'set cheap cctq gpt-5.6-terra medium --fallback deepseek-official deepseek-v4-flash high', signal: undefined })
  assert.equal(r1.kind, 'success', r1.text)
  assert.ok(r1.text.includes('gpt-5.6-terra'), r1.text)
  assert.ok(r1.text.includes('deepseek-official/deepseek-v4-flash@high'), r1.text)
  const r2 = await cmd.handler({ agent: main, rawInput: 'set strong follow-session', signal: undefined })
  assert.equal(r2.kind, 'error', 'follow-session tokens are gone')
  assert.ok(r2.text.includes('usage:'), r2.text)
  const r3 = await cmd.handler({ agent: main, rawInput: 'set cheap cctq gpt-5.6-terra medium --fallback cctq gpt-5.6-terra max', signal: undefined })
  assert.equal(r3.kind, 'error', 'fallback effort max is undeclared for cctq')
  assert.ok(r3.text.includes('declares only'), r3.text)
})

test('/tier effort validates against the cheap model declarations', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const ok = await cmd.handler({ agent: main, rawInput: 'effort high', signal: undefined })
  assert.equal(ok.kind, 'success', ok.text)
  assert.ok(ok.text.includes('set to "high"'), ok.text)
  const bad = await cmd.handler({ agent: main, rawInput: 'effort max', signal: undefined })
  assert.equal(bad.kind, 'error')
  assert.ok(bad.text.includes('declares only low, medium, high'), bad.text)
})

test('tier_configure rejects undeclared efforts and validates fallback chains', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r1 = await configure.execute({ tier: 'cheap', provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'max' }, { agent: main, signal: undefined })
  assert.equal(r1.ok, false)
  assert.ok(r1.message.includes('low, medium, high'), r1.message)
  const r2 = await configure.execute({ tier: 'cheap', provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'high', fallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }], sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r2.ok, true, r2.message)
  const r3 = await configure.execute({ tier: 'cheap', provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium', fallback: [{ provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'max' }], sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r3.ok, false, 'fallback entry effort must be declared by its model')
  assert.ok(r3.message.includes('low, medium, high'), r3.message)
})

test('foreground tier_worker settles with the worker result via startActivation', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
  const out = await worker.execute({ task: 'say ok', tier: 'cheap' }, { agent: main, signal: undefined })
  assert.equal(out.output, 'worker-ok')
  assert.equal(out.stopReason, 'stop')
  assert.equal(out.model, 'gpt-5.6-terra')
  assert.equal(services.subagents.started.length, 1)
  const spec = services.subagents.started[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.label, 'say ok')
  assert.deepEqual(spec.request.agentOptions, {
    provider: 'cctq',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
  })
})

test('tier_worker passes agentPreset to startActivation', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
  const out = await worker.execute({ task: 'say ok', agentPreset: 'minimal' }, { agent: main, signal: undefined })
  assert.equal(out.output, 'worker-ok')
  assert.equal(services.subagents.started[0].request.agentPreset, 'minimal')
})

test('background tier_worker resolves a proper JobOutcome with a SessionId owner', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
  const out = await worker.execute({ task: 'say ok', tier: 'cheap', background: true }, { agent: main, signal: undefined })
  assert.equal(out.background, true)
  assert.equal(out.jobId, 'subagent-1')
  assert.equal(services.jobs.lastSpec.owner, 'session-main', 'jobs owner is the SessionId')
  assert.ok(services.jobs.hooks, 'jobs.start invoked the producer run()')
  const outcome = await services.jobs.hooks.done
  assert.equal(outcome.status, 'completed')
  assert.ok(outcome.detail.includes('cctq/gpt-5.6-terra'), 'detail carries tier/model')
  assert.equal(outcome.output, 'worker-ok')
})

test('tier_configure persists through the settings bridge by default', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r1 = await configure.execute({ tier: 'cheap', provider: 'opencode-go', model: 'deepseek-v4-flash' }, { agent: main, signal: undefined })
  assert.equal(r1.ok, true)
  assert.equal(services.settings.updates.length, 1, 'persisted once by default')
  const { ns, patch } = services.settings.updates[0]
  assert.equal(ns, 'tier-routing')
  assert.equal(patch.mode, 'auto')
  assert.equal(patch.cheapProvider, 'opencode-go')
  assert.deepEqual(patch.cheapFallback, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }])
  assert.equal(patch.subagentPolicy, 'inherit')
  await configure.execute({ tier: 'strong', provider: 'opencode-go', model: 'deepseek-v4-pro', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(services.settings.updates.length, 1, 'sessionOnly skipped persistence')
})

test('tier_advisor and tier_review stream through the configured strong tier', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  const review = services.tools.registered.find((t) => t.name === 'tier_review')
  assert.ok(advisor.description.includes('configured as deepseek-official/deepseek-v4-pro'), advisor.description)
  assert.ok(review.description.includes('configured as deepseek-official/deepseek-v4-pro'), review.description)
  const a = await advisor.execute({ question: 'should we proceed?' }, { agent: makeAgent('main'), signal: undefined })
  assert.equal(a.advice, 'MOCK ADVICE')
  assert.equal(a.ok, true)
  assert.equal(a.provider, 'deepseek-official')
  assert.equal(a.model, 'deepseek-v4-pro')
  const r = await review.execute({ focus: 'the change set' }, { agent: makeAgent('main'), signal: undefined })
  assert.equal(r.verdict, 'UNPARSED')
  assert.equal(r.ok, true)
})

test('advisor and review walk the strong fallback chain when the primary route fails', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r0 = await configure.execute({ tier: 'strong', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r0.ok, true, r0.message)
  const tried = []
  services.llm.stream = async function* (opts) {
    tried.push(opts.provider + '/' + opts.model)
    if (opts.provider === 'opencode-go') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'QUOTA' } } }
      return
    }
    yield { type: 'text-delta', text: 'APPROVE\nchain ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  const a = await advisor.execute({ question: 'proceed?' }, { agent: makeAgent('main'), signal: undefined })
  assert.equal(a.ok, true)
  assert.deepEqual([a.provider, a.model], ['deepseek-official', 'deepseek-v4-pro'], 'the answer names the route that served it')
  assert.deepEqual(tried, ['opencode-go/deepseek-v4-flash', 'deepseek-official/deepseek-v4-pro'])
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const review = await cmd.handler({ agent: makeAgent('main'), rawInput: 'review the diff', signal: undefined })
  assert.ok(review.text.startsWith('Review (deepseek-official/deepseek-v4-pro):'), review.text)
  assert.deepEqual(tried.slice(2), ['opencode-go/deepseek-v4-flash', 'deepseek-official/deepseek-v4-pro'])
})

test('consultations stop on failures the main path does not fall back on', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  let calls = 0
  services.llm.stream = async function* () {
    calls += 1
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'prompt too long', code: 'CONTEXT_WINDOW_EXCEEDED' } } }
  }
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  const a = await advisor.execute({ question: 'q' }, { agent: makeAgent('main'), signal: undefined })
  assert.equal(a.ok, false)
  assert.equal(calls, 1, 'no chain walk on a context-size failure')
})

test('tier_status warns when the reviewer shares a model family with an implementer', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  // The reviewer is the strong config (deepseek), cheap is gpt: no shared family.
  const clean = await status.execute({}, { agent: makeAgent('main'), signal: undefined })
  assert.ok(clean.status.includes('(no implementer shares its family)'), clean.status)
  // Point cheap at a deepseek-family model: the same-family warning appears.
  await cmd.handler({ agent: makeAgent('main'), rawInput: 'set cheap deepseek-official deepseek-v4-flash high', signal: undefined })
  const out = await status.execute({}, { agent: makeAgent('main'), signal: undefined })
  assert.ok(out.status.includes('review: deepseek-official/deepseek-v4-pro (family deepseek) WARNING'), out.status)
  assert.ok(out.status.includes('cheap tier deepseek-official/deepseek-v4-flash'), out.status)
})

test('a tier tries its configured chain entries in order', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r = await configure.execute({ tier: 'strong', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r.ok, true, r.message)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  let req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-flash', 'the explicit strong config is the primary route')
  for (const fn of ctx.listeners['agent/request-error']) await fn({ agent: main, failure: { message: 'quota', code: 'QUOTA' } }, async () => undefined)
  req = await runRequest(ctx, main)
  assert.deepEqual([req.provider, req.model, req.reasoningEffort], ['deepseek-official', 'deepseek-v4-pro', 'max'], 'then the configured chain entry')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('fallback: deepseek-official/deepseek-v4-pro@max'), out.status)
})

test('roles route advisor and reviewer on their own model and fall back to the strong route', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const tried = []
  services.llm.stream = async function* (opts) {
    tried.push(opts.provider + '/' + opts.model)
    if (opts.provider === 'opencode-go') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'QUOTA' } } }
      return
    }
    yield { type: 'text-delta', text: 'APPROVE\nok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const review = services.tools.registered.find((t) => t.name === 'tier_review')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r1 = await configure.execute({ tier: 'reviewer', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r1.ok, true, r1.message)
  assert.ok(r1.message.includes('inactive until /tier roles on'), r1.message)
  await review.execute({ focus: 'x' }, { agent: main, signal: undefined })
  assert.deepEqual(tried, ['deepseek-official/deepseek-v4-pro'], 'roles off: the review uses the strong route')
  tried.length = 0
  const on = await cmd.handler({ agent: main, rawInput: 'roles on', signal: undefined })
  assert.equal(on.kind, 'success', on.text)
  const out = await review.execute({ focus: 'x' }, { agent: main, signal: undefined })
  assert.deepEqual(tried, ['opencode-go/deepseek-v4-flash', 'deepseek-official/deepseek-v4-pro'], 'the role route failed, then the strong route answered')
  assert.deepEqual([out.provider, out.model], ['deepseek-official', 'deepseek-v4-pro'], 'the verdict names the route that answered')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const st = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(st.status.includes('review: opencode-go/deepseek-v4-flash (family deepseek)'), st.status)
  assert.ok(st.status.includes('(no implementer shares its family)'), st.status)
  assert.ok(!st.status.includes('review chain: WARNING'), st.status)
  const rejected = await configure.execute({ tier: 'advisor', provider: 'cctq', model: 'gpt-5.6-sol', fallback: [] }, { agent: main, signal: undefined })
  assert.equal(rejected.ok, false)
  assert.ok(rejected.message.includes('share the strong fallback chain'), rejected.message)
})

test('the reviewer chain warns only when a fallback step shares an implementer family', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'claude-opus-4', reasoningEffort: 'high' })
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  // Strong route without session-follow and without a chain: the reviewer's chain is deepseek only.
  await configure.execute({ tier: 'strong', provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max', fallback: [], sessionOnly: true }, { agent: main, signal: undefined })
  await configure.execute({ tier: 'reviewer', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  await cmd.handler({ agent: main, rawInput: 'roles on', signal: undefined })
  const clean = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(!clean.status.includes('review chain: WARNING'), clean.status)
  assert.ok(clean.status.includes('(no implementer shares its family)'), clean.status)
})

test('three-tier layout: plan runs on main, execution on cheap, escalation on strong', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r = await configure.execute({ tier: 'strong', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r.ok, true, r.message)
  const layout = await cmd.handler({ agent: main, rawInput: 'layout three', signal: undefined })
  assert.equal(layout.kind, 'success', layout.text)
  let req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra', 'execution routes to the cheap tier')
  main.session.events.push({ type: 'plan/mode', data: { active: true } })
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-pro', 'plan mode runs on the main tier (explicit config)')
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'boom 1' } })
    await fn({ agent: main, error: { message: 'boom 2' } })
  }
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-flash', 'repeated errors escalate to the strong tier')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('three tiers'), out.status)
})

test('caller policy routes a subagent child on the parent current route', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  services.agents.register(main)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  const set = await cmd.handler({ agent: main, rawInput: 'subagent caller', signal: undefined })
  assert.equal(set.kind, 'success', set.text)
  const child = makeAgent('child', 'subagent')
  child.session.header.isSeeded = true
  child.session.header.parentSession = 'session-main'
  // DSH seeds the child with the parent's route; the parent is on strong.
  const req = await runRequest(ctx, child, { ...SESSION_DEFAULT })
  assert.deepEqual([req.provider, req.model], ['deepseek-official', 'deepseek-v4-pro'], 'the fork child follows the parent, not the cheap tier')
})

test('an explicit subagent route is kept until failure escalation overrides it', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  services.agents.register(main)
  const child = makeAgent('child', 'subagent')
  child.session.header.parentSession = 'session-main'
  const explicit = { provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
  let req = await runRequest(ctx, child, explicit)
  assert.deepEqual([req.provider, req.model, req.reasoningEffort], ['opencode-go', 'deepseek-v4-flash', 'high'], 'the caller-chosen route is kept')
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: child, error: { message: 'boom 1' } })
    await fn({ agent: child, error: { message: 'boom 2' } })
  }
  req = await runRequest(ctx, child, explicit)
  assert.equal(req.model, 'deepseek-v4-pro', 'escalation routes the explicit child to strong')
})

test('fork and spawn children take their own subagent policy', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  services.agents.register(main)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  const set = await cmd.handler({ agent: main, rawInput: 'subagent fork caller', signal: undefined })
  assert.equal(set.kind, 'success', set.text)
  const fork = makeAgent('fork', 'subagent')
  fork.session.header.isSeeded = true
  fork.session.header.parentSession = 'session-main'
  const spawn = makeAgent('spawn', 'subagent')
  spawn.session.header.parentSession = 'session-main'
  const f = await runRequest(ctx, fork, { ...SESSION_DEFAULT })
  assert.equal(f.model, 'deepseek-v4-pro', 'fork child follows the parent (caller)')
  const s = await runRequest(ctx, spawn, { ...SESSION_DEFAULT })
  assert.equal(s.model, 'gpt-5.6-terra', 'spawn child keeps the inherit rules (cheap in auto)')
})

test('caller is refused for spawn children, both by command and by configuration', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r = await cmd.handler({ agent: main, rawInput: 'subagent spawn caller', signal: undefined })
  assert.equal(r.kind, 'error')
  assert.ok(r.text.includes('fork children only'), r.text)
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  // The tool schema refuses caller for spawn before the handler runs.
  await assert.rejects(configure.execute({ tier: 'cheap', spawnPolicy: 'caller', sessionOnly: true }, { agent: main, signal: undefined }), /spawnPolicy/)
})

test('capped subagents never route above main', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  services.agents.register(main)
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  await cmd.handler({ agent: main, rawInput: 'layout three', signal: undefined })
  const m = await configure.execute({ tier: 'main', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(m.ok, true, m.message)
  await cmd.handler({ agent: main, rawInput: 'subagent fork capped', signal: undefined })
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  const fork = makeAgent('fork', 'subagent')
  fork.session.header.isSeeded = true
  fork.session.header.parentSession = 'session-main'
  const f = await runRequest(ctx, fork, { ...SESSION_DEFAULT })
  assert.equal(f.model, 'deepseek-v4-flash', 'a strong parent gives the child main, not strong')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const fork2 = makeAgent('fork2', 'subagent')
  fork2.session.header.isSeeded = true
  fork2.session.header.parentSession = 'session-main'
  const f2 = await runRequest(ctx, fork2, { provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
  assert.equal(f2.model, 'gpt-5.6-terra', 'a cheap parent keeps its cheap route')
})

test('plan-exit gate: explore first, one advisor review, then the plan is presented', async () => {
  const { ctx } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const guard = ctx.listeners['tools/pre-execute'][0]
  const next = async () => 'ran'
  const exit = (plan) => guard({ agent: main, name: 'exit_plan_mode', arguments: { plan } }, next)
  // Reads before plan mode do not count toward the plan's exploration.
  await guard({ agent: main, name: 'read', arguments: { path: 'a' } }, next)
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  let r = await exit('# Plan\n- step')
  assert.equal(r.kind, 'deny')
  assert.ok(r.reason.includes('explore before presenting the plan: 0 read/search'), r.reason)
  await guard({ agent: main, name: 'read', arguments: { path: 'a' } }, next)
  await guard({ agent: main, name: 'grep', arguments: { pattern: 'x' } }, next)
  r = await exit('# Plan\n- step')
  assert.equal(r.kind, 'deny')
  assert.ok(r.reason.startsWith('Advisor review before presenting the plan'), r.reason)
  assert.ok(r.reason.includes('MOCK ADVICE'), r.reason)
  assert.equal(await exit('# Plan v2 revised'), 'ran', 'the revised plan is presented after the single review')
})

test('plan-exit gate: the advisor review can be switched off, exploration still counts', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const set = await cmd.handler({ agent: main, rawInput: 'gate advisor off', signal: undefined })
  assert.equal(set.kind, 'success', set.text)
  const guard = ctx.listeners['tools/pre-execute'][0]
  const next = async () => 'ran'
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  await guard({ agent: main, name: 'read', arguments: { path: 'a' } }, next)
  await guard({ agent: main, name: 'glob', arguments: { pattern: '*' } }, next)
  assert.equal(await guard({ agent: main, name: 'exit_plan_mode', arguments: { plan: '# Plan' } }, next), 'ran')
})

test('plan-exit gate: an unavailable advisor does not block the plan', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.llm.stream = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'QUOTA' } } }
  }
  const main = makeAgent('main')
  const guard = ctx.listeners['tools/pre-execute'][0]
  const next = async () => 'ran'
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  await guard({ agent: main, name: 'read', arguments: { path: 'a' } }, next)
  await guard({ agent: main, name: 'read', arguments: { path: 'b' } }, next)
  assert.equal(await guard({ agent: main, name: 'exit_plan_mode', arguments: { plan: '# Plan' } }, next), 'ran')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('advisor unavailable: plan presented without advisor review'), out.status)
})

test('waterfall mode never appends request/header from listeners or commands', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  await cmd.handler({ agent: main, rawInput: 'strong', signal: undefined })
  await cmd.handler({ agent: main, rawInput: 'plan', signal: undefined })
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  await cmd.handler({ agent: main, rawInput: 'off', signal: undefined })
  assert.equal(main.writes.filter((w) => w.kind === 'request/header').length, 0, 'the loop, not the plugin, logs request/header in waterfall mode')
})

test('the main tier stays inactive until the three-tier layout is enabled', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r = await cmd.handler({ agent: main, rawInput: 'main', signal: undefined })
  assert.ok(r.text.includes('inactive'), r.text)
  const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
  await assert.rejects(worker.execute({ task: 'x', tier: 'main' }, { agent: main, signal: undefined }), /main tier is inactive/)
})

test('guard denies high-impact commands on the cheap tier', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const guard = ctx.listeners['tools/pre-execute'][0]
  let nextCalled = 0
  const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => { nextCalled += 1 })
  assert.equal(result.kind, 'deny')
  assert.ok(result.reason.includes('cheap tier'))
  assert.equal(nextCalled, 0)
  const allowed = await guard({ agent: main, name: 'bash', arguments: { command: 'ls -la' } }, async () => 'ok')
  assert.equal(allowed, 'ok')
})

test('auto routing folds plan state from the session log when planMode is unreachable', async () => {
  const { ctx, services } = makeContext()
  services.planMode = undefined
  applyAgent(ctx)
  const main = makeAgent('main')
  main.session.events.push({ type: 'plan/mode', data: { active: true } })
  const req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-pro', 'plan-active session routes strong without the planMode service')
})

test('/tier plan appends plan/mode to the session log when planMode is unreachable', async () => {
  const { ctx, services } = makeContext()
  services.planMode = undefined
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const out = await cmd.handler({ agent: main, rawInput: 'plan', signal: undefined })
  assert.ok(out.text.includes('Plan mode: committed'), out.text)
  const appended = main.writes.filter((w) => w.kind === 'plan/mode')
  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0].payload, { active: true })
})

test('/tier status reports seam health, fallback chains and cheap effort', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const out = await cmd.handler({ agent: main, rawInput: 'status', signal: undefined })
  assert.ok(out.text.includes('fallback: deepseek-official/deepseek-v4-pro@max'), out.text)
  assert.ok(out.text.includes('fallback: deepseek-official/deepseek-v4-flash@high'), out.text)
  assert.ok(out.text.includes('fallback TTL: 300s'), out.text)
  assert.ok(out.text.includes('routing seam: waterfall'), out.text)
  assert.ok(out.text.includes('seams: all ok'), out.text)
})

test('degraded mode: missing settings keeps the plugin alive and honest', async () => {
  const { ctx, services } = makeContext()
  services.settings = undefined
  applyAgent(ctx)
  const main = makeAgent('main')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('in-memory only'), out.status)
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r = await configure.execute({ tier: 'cheap', provider: 'cctq', model: 'gpt-5.6-terra' }, { agent: main, signal: undefined })
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('session-only'), r.message)
})

test('missing llm disables the plugin without throwing', () => {
  const { ctx, services } = makeContext()
  services.llm = undefined
  applyAgent(ctx)
  assert.equal(services.tools.registered.length, 0)
})

test('volatile-ref settings values are unwrapped and applied', async () => {
  const { ctx, services } = makeContext()
  // Wrap every persisted field in a Volatile-shaped ref, as the real host
  // row's parsed config returns them.
  const inner = services.settings.describe
  services.settings.describe = () => inner().map((d) => ({
    ns: d.ns,
    value: Object.fromEntries(Object.entries(d.value).map(([k, v]) => [k, { get: () => v }])),
  }))
  applyAgent(ctx)
  const main = makeAgent('main')
  const req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra', 'volatile refs must be unwrapped into real values')
})

test('guard denies high-impact pwsh commands on Windows shell tools', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const guard = ctx.listeners['tools/pre-execute'][0]
  const denied = await guard({ agent: main, name: 'pwsh', arguments: { command: 'rm -rf /tmp/x' } }, async () => {})
  assert.equal(denied.kind, 'deny')
})

test('abort-class failures do not advance the escalation counter', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'aborted', code: 'ABORTED' } })
    await fn({ agent: main, error: { message: 'aborted', code: 'ABORTED' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(!out.status.includes('ESCALATED'), out.status)
})

// ---- smart mode & Tierkick --------------------------------------------------

test('smart mode pins the main agent to the plan tier and blocks direct file edits', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  const r = await route.execute({ tier: 'smart' }, { agent: main, signal: undefined })
  assert.equal(r.applied, 'smart')
  const req = await runRequest(ctx, main, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  // two-tier layout: plan tier = strong = deepseek-v4-pro@max
  assert.equal(req.model, 'deepseek-v4-pro')
  assert.equal(req.provider, 'deepseek-official')

  const guard = ctx.listeners['tools/pre-execute'][0]
  for (const name of ['write', 'edit', 'multi_edit', 'patch']) {
    const denied = await guard({ agent: main, name, arguments: {} }, async () => ({}))
    assert.equal(denied.kind, 'deny', name + ' denied for smart main')
    assert.ok(denied.reason.includes('tier_sidekick'), name + ' reason mentions sidekick')
  }
  const allowed = await guard({ agent: main, name: 'read', arguments: {} }, async () => ({}))
  assert.ok(allowed === undefined || allowed.kind !== 'deny', 'read passes for smart main')
})

test('tier_sidekick spawns a child on the stage route and caches explored snippets', async () => {
  const { ctx, services } = makeContext({
    workerResult: 'Snippet: src/parser.ts | 1-25 | export function parseRequest(req) { return req.body } | parses the request body',
  })
  applyAgent(ctx)
  const main = makeAgent('main')
  const sk = services.tools.registered.find((t) => t.name === 'tier_sidekick')
  assert.ok(sk, 'tier_sidekick tool registered')
  const out = await sk.execute({ stage: 'explore', task: 'find the parser', paths: ['src'] }, { agent: main, signal: undefined })
  assert.equal(out.stage, 'explore')
  assert.equal(out.ok, true)
  assert.equal(out.snippets.length, 1)
  assert.equal(out.snippets[0].path, 'src/parser.ts')
  const spawn = services.subagents.started.at(-1)
  assert.equal(spawn.label, 'sidekick:explore')
  assert.equal(spawn.request.agentOptions.provider, 'cctq')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const found = await cmd.handler({ rawInput: 'cache search parseRequest', agent: main, signal: undefined })
  assert.equal(found.kind, 'success', found.text)
  assert.ok(found.text.includes('src/parser.ts'), found.text)
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const st = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(st.status.includes('turbovec cache: snippets=1'), st.status)
})

test('tier_sidekick implement invalidates and re-indexes touched files', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const sk = services.tools.registered.find((t) => t.name === 'tier_sidekick')
  const out = await sk.execute({ stage: 'implement', task: 'write the parser' }, { agent: main, signal: undefined })
  assert.equal(out.stage, 'implement')
  assert.equal(out.ok, true)
  assert.equal(out.touchedFiles.length, 0) // mock returns generic worker output, no parsed files
})

// ---- advisor budget ---------------------------------------------------------

test('advisor budget: two free calls, the third asks and fails closed without approval', async () => {
  const { ctx, services } = makeContext({ approvalOutcome: 'cancelled' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  const execCtx = { agent: main, signal: undefined }
  const one = await advisor.execute({ question: 'q1' }, execCtx)
  const two = await advisor.execute({ question: 'q2' }, execCtx)
  assert.equal(one.ok, true)
  assert.equal(two.ok, true)
  const three = await advisor.execute({ question: 'q3' }, execCtx)
  assert.equal(three.ok, false)
  assert.ok(three.advice.includes('per-turn limit'), three.advice)
  assert.equal(services.approval.requests.length, 1)
  assert.ok(services.approval.requests[0].reason.includes('Allow another call'))
})

test('advisor budget: user approval lets the third call through', async () => {
  const { ctx, services } = makeContext({ approvalOutcome: 'allowed-once' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  await advisor.execute({ question: 'q1' }, { agent: main, signal: undefined })
  await advisor.execute({ question: 'q2' }, { agent: main, signal: undefined })
  const three = await advisor.execute({ question: 'q3' }, { agent: main, signal: undefined })
  assert.equal(three.ok, true)
  assert.equal(services.approval.requests.length, 1)
})

test('advisor budget resets on a new user message', async () => {
  const { ctx, services } = makeContext({ approvalOutcome: 'cancelled' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  await advisor.execute({ question: 'q1' }, { agent: main, signal: undefined })
  await advisor.execute({ question: 'q2' }, { agent: main, signal: undefined })
  const inbox = ctx.listeners['agent/inbox/inserted'][0]
  await inbox({ agent: main, message: { source: { kind: 'user' }, content: 'hi' } })
  const again = await advisor.execute({ question: 'q3' }, { agent: main, signal: undefined })
  assert.equal(again.ok, true)
})

// ---- forceTierOnExplicitModel ------------------------------------------------

test('forceTierOnExplicitModel routes explicit-model children by tier policy', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const on = await cmd.handler({ rawInput: 'subagent force-explicit on', agent: main, signal: undefined })
  assert.equal(on.kind, 'success', on.text)
  const child = makeAgent('child', 'subagent')
  const req = await runRequest(ctx, child, { provider: 'opencode-go', model: 'custom-model', reasoningEffort: 'high' })
  assert.equal(req.provider, 'cctq')
})

// ---- paths[] evidence + /tier cache -----------------------------------------

test('tier_advisor attaches paths content as evidence', async () => {
  const { ctx, services } = makeContext({
    fs: { files: [['src/a.ts', 'export function parseRequest(req) {}']] },
  })
  applyAgent(ctx)
  const main = makeAgent('main')
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  const out = await advisor.execute({ question: 'design?', paths: ['src/a.ts'] }, { agent: main, signal: undefined })
  assert.equal(out.ok, true)
  const opts = services.llm.lastStreamOptions
  const text = opts.messages[0].content[0].text
  assert.ok(text.includes('File src/a.ts'), text)
  assert.ok(text.includes('parseRequest'), text)
})

test('tier_sidekick remembers prior outcomes via digest cards', async () => {
  const { ctx, services } = makeContext({
    workerResult: [
      'Touched files:',
      '- src/parser.ts',
      'Diff summary: added body validation.',
      'Checks: npm test: pass',
    ].join('\n'),
  })
  applyAgent(ctx)
  const main = makeAgent('main')
  const sk = services.tools.registered.find((t) => t.name === 'tier_sidekick')
  const first = await sk.execute({ stage: 'implement', task: 'write parser validation' }, { agent: main, signal: undefined })
  assert.equal(first.ok, true)
  assert.deepEqual(first.touchedFiles, ['src/parser.ts'])
  const second = await sk.execute({ stage: 'implement', task: 'parser validation update' }, { agent: main, signal: undefined })
  assert.equal(second.ok, true)
  const promptText = services.subagents.started.at(-1).request.prompt[0].text
  assert.ok(promptText.includes('Previous outcomes (memory):'), promptText)
  assert.ok(promptText.includes('• [implement/src/parser.ts]'), promptText)
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const st = await cmd.handler({ rawInput: 'cache status', agent: main, signal: undefined })
  assert.equal(st.kind, 'success', st.text)
  assert.ok(st.text.includes('digests=1'), st.text)
  assert.ok(st.text.includes('digestHits=1'), st.text)
})

test('sidekick prompts share a byte-stable prefix within a stage', async () => {
  const { ctx, services } = makeContext({
    workerResults: [
      'Snippet: src/parser.ts | 1-25 | export function parseRequest(req) { return req.body } | ok',
      'Snippet: src/parser.ts | 1-25 | export function parseRequest(req) { return req.body } | ok',
    ],
  })
  applyAgent(ctx)
  const main = makeAgent('main')
  const sk = services.tools.registered.find((t) => t.name === 'tier_sidekick')
  await sk.execute({ stage: 'explore', task: 'find parser' }, { agent: main, signal: undefined })
  await sk.execute({ stage: 'explore', task: 'find renderer' }, { agent: main, signal: undefined })
  const p1 = services.subagents.started[0].request.prompt[0].text
  const p2 = services.subagents.started[1].request.prompt[0].text
  const cut = 'Task: '
  const i1 = p1.indexOf(cut)
  const i2 = p2.indexOf(cut)
  assert.ok(i1 > 0 && i2 > 0)
  assert.equal(p1.slice(0, i1), p2.slice(0, i2), 'stable stage prefix')
})

test('paths[] scopes snippet search in the sidekick prompt', async () => {
  const { ctx, services } = makeContext({
    workerResults: [
      'Snippet: src/parser.ts | 1-25 | export function parseRequest(req) { return req.body } | parses request body',
      'Snippet: lib/routing.js | 10-20 | export function resolveRoute(agent, seed) { return null } | routes a request',
    ],
  })
  applyAgent(ctx)
  const main = makeAgent('main')
  const sk = services.tools.registered.find((t) => t.name === 'tier_sidekick')
  await sk.execute({ stage: 'explore', task: 'find parser' }, { agent: main, signal: undefined })
  await sk.execute({ stage: 'explore', task: 'find routing' }, { agent: main, signal: undefined })
  await sk.execute({ stage: 'explore', task: 'find parser code', paths: ['src'] }, { agent: main, signal: undefined })
  const promptText = services.subagents.started.at(-1).request.prompt[0].text
  assert.ok(promptText.includes('src/parser.ts'), promptText)
  assert.ok(!promptText.includes('lib/routing.js'), promptText)
})

test('/tier sidekick set and cache status/clear/search', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  let r = await cmd.handler({ rawInput: 'set sidekick-explore opencode-go gpt-5.6-terra high', agent: main, signal: undefined })
  assert.equal(r.kind, 'success', r.text)
  r = await cmd.handler({ rawInput: 'cache status', agent: main, signal: undefined })
  assert.equal(r.kind, 'success')
  assert.ok(r.text.includes('TurboQuant cache'), r.text)
  r = await cmd.handler({ rawInput: 'cache clear', agent: main, signal: undefined })
  assert.equal(r.kind, 'success')
  r = await cmd.handler({ rawInput: 'cache search parseRequest', agent: main, signal: undefined })
  assert.equal(r.kind, 'success')
})

// ---- reviewer follow-ups: enforcement points & edge cases -------------------

test('smart mode blocks main edits but allows child (sidekick) delegation', async () => {
  const { ctx } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const child = makeAgent('child', 'subagent')
  const route = ctx.services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'smart' }, { agent: main, signal: undefined })
  const guard = ctx.listeners['tools/pre-execute'][0]
  const denied = await guard({ agent: main, name: 'write', arguments: {} }, async () => ({}))
  assert.equal(denied.kind, 'deny')
  const allowed = await guard({ agent: child, name: 'write', arguments: {} }, async () => ({}))
  assert.ok(allowed === undefined || allowed.kind !== 'deny', 'children may write (delegation path)')
})

test('smart mode + forceTierOnExplicitModel routes explicit children by tier', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'smart' }, { agent: main, signal: undefined })
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  await cmd.handler({ rawInput: 'subagent force-explicit on', agent: main, signal: undefined })
  const child = makeAgent('child', 'subagent')
  const req = await runRequest(ctx, child, { provider: 'opencode-go', model: 'custom-model', reasoningEffort: 'high' })
  assert.equal(req.provider, 'cctq')
})

test('advisor budget is not reset by empty or text-less messages', async () => {
  const { ctx, services } = makeContext({ approvalOutcome: 'cancelled' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  await advisor.execute({ question: 'q1' }, { agent: main, signal: undefined })
  await advisor.execute({ question: 'q2' }, { agent: main, signal: undefined })
  const inbox = ctx.listeners['agent/inbox/inserted'][0]
  await inbox({ agent: main, message: { source: { kind: 'user' }, content: [] } })
  const three = await advisor.execute({ question: 'q3' }, { agent: main, signal: undefined })
  assert.equal(three.ok, false, 'budget stays exhausted after empty message')
})

test('persisted settings without new v0.8.0 fields keep their defaults', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('advisor budget: max=2/turn'), out.status)
  assert.ok(out.status.includes('forceTierOnExplicitModel=off'), out.status)
})

test('config fields with wrong types fall back to defaults', async () => {
  const { ctx, services } = makeContext()
  const inner = services.settings.describe
  services.settings.describe = () => inner().map((d) => ({
    ns: d.ns,
    value: { ...d.value, advisorMaxCallsPerTurn: 'banana', advisorConfirmTimeoutSec: null, forceTierOnExplicitModel: 'yes' },
  }))
  applyAgent(ctx)
  const main = makeAgent('main')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('advisor budget: max=2/turn'), out.status)
  assert.ok(out.status.includes('forceTierOnExplicitModel=off'), out.status)
})

test('advisor budget is not reset by whitespace-only messages', async () => {
  const { ctx, services } = makeContext({ approvalOutcome: 'cancelled' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  await advisor.execute({ question: 'q1' }, { agent: main, signal: undefined })
  await advisor.execute({ question: 'q2' }, { agent: main, signal: undefined })
  const inbox = ctx.listeners['agent/inbox/inserted'][0]
  await inbox({ agent: main, message: { source: { kind: 'user' }, content: '   ' } })
  const three = await advisor.execute({ question: 'q3' }, { agent: main, signal: undefined })
  assert.equal(three.ok, false, 'budget stays exhausted after whitespace-only message')
})

test('smart mode without forceTier keeps the explicit child seed', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  services.agents.register(main)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'smart' }, { agent: main, signal: undefined })
  const child = makeAgent('child', 'subagent')
  child.session.header.parentSession = main.session.id
  const req = await runRequest(ctx, child, { provider: 'opencode-go', model: 'custom-model', reasoningEffort: 'high' })
  assert.equal(req.provider, 'opencode-go')
  assert.equal(req.model, 'custom-model')
})

// ---- decision model (Jev / System One / OpenRouter Decisions) --------------

function patchFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    const value = await handler(body, url, opts)
    return { ok: true, status: 200, json: async () => value }
  }
  return { calls, restore() { globalThis.fetch = original } }
}

const DECISION_CFG = {
  decisionModel: 'jevens/jev-1.5',
  decisionBaseUrl: 'https://openrouter.ai',
  decisionPath: '/api/alpha/decisions',
  decisionApiKey: 'sk-test',
  decisionStages: ['guard', 'escalate', 'worker', 'consult'],
  decisionApproveAt: 0.9,
  decisionBlockAt: 0.1,
  decisionTimeoutMs: 5000,
  decisionBudgetPerTurn: 10,
}

function withDecisionSettings(ctx, cfg = DECISION_CFG) {
  const inner = ctx.services.settings.describe
  ctx.services.settings.describe = () => inner().map((d) => ({ ns: d.ns, value: { ...d.value, ...cfg } }))
}

function noulAnswers(p) {
  return (body) => {
    const answers = {}
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: p }
      else answers[id] = { type: 'choice', choice: 'strong', confidence: p }
    }
    return { answers }
  }
}

test('guard second stage: an approve allows the denied command', async () => {
  const pf = patchFetch(noulAnswers(0.99))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const route = services.tools.registered.find((t) => t.name === 'tier_route')
    await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
    const guard = ctx.listeners['tools/pre-execute'][0]
    let nextCalled = 0
    const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => { nextCalled += 1; return 'ok' })
    assert.equal(result, 'ok')
    assert.equal(nextCalled, 1)
    assert.equal(pf.calls.length, 1)
  } finally { pf.restore() }
})

test('guard second stage: block keeps the deterministic deny', async () => {
  const pf = patchFetch(noulAnswers(0.05))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const route = services.tools.registered.find((t) => t.name === 'tier_route')
    await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
    const guard = ctx.listeners['tools/pre-execute'][0]
    const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => {})
    assert.equal(result.kind, 'deny')
    assert.ok(result.reason.includes('cheap tier'))
  } finally { pf.restore() }
})

test('guard fail-closed: decision endpoint errors never weaken the deny', async () => {
  const pf = patchFetch(async () => { throw new Error('network down') })
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const route = services.tools.registered.find((t) => t.name === 'tier_route')
    await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
    const guard = ctx.listeners['tools/pre-execute'][0]
    const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => {})
    assert.equal(result.kind, 'deny')
    const status = services.tools.registered.find((t) => t.name === 'tier_status')
    const out = await status.execute({}, { agent: main, signal: undefined })
    assert.ok(out.status.includes('decisionErrors=1'), out.status)
  } finally { pf.restore() }
})

test('escalation triage: a confident "not a model fault" blocks escalation', async () => {
  const pf = patchFetch(noulAnswers(0.05))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    for (const fn of ctx.listeners['agent/error']) {
      await fn({ agent: main, error: { message: 'boom 1' } })
      await fn({ agent: main, error: { message: 'boom 2' } })
    }
    const status = services.tools.registered.find((t) => t.name === 'tier_status')
    const out = await status.execute({}, { agent: main, signal: undefined })
    assert.ok(!out.status.includes('ESCALATED'), out.status)
    const req = await runRequest(ctx, main)
    assert.equal(req.model, 'gpt-5.6-terra', 'stays on cheap when the model says the task is at fault')
  } finally { pf.restore() }
})

test('escalation triage: approve escalates as usual', async () => {
  const pf = patchFetch(noulAnswers(0.99))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    for (const fn of ctx.listeners['agent/error']) {
      await fn({ agent: main, error: { message: 'boom 1' } })
      await fn({ agent: main, error: { message: 'boom 2' } })
    }
    const status = services.tools.registered.find((t) => t.name === 'tier_status')
    const out = await status.execute({}, { agent: main, signal: undefined })
    assert.ok(out.status.includes('ESCALATED'), out.status)
    const req = await runRequest(ctx, main)
    assert.equal(req.model, 'deepseek-v4-pro')
  } finally { pf.restore() }
})

test('tier_worker consults the decision model for tier choice when none is specified', async () => {
  const pf = patchFetch(noulAnswers(0.99))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
    let out
    try {
      out = await worker.execute({ task: 'analyze this deeply' }, { agent: main, signal: undefined })
    } catch (e) {
      console.log('DBG worker threw:', String(e && e.stack || e))
      throw e
    }
    assert.equal(out.tier, 'strong')
    assert.equal(out.model, 'deepseek-v4-pro')
    const spec = services.subagents.started[0]
    assert.ok(spec, 'spawned spec was recorded')
    assert.ok(spec.request && spec.request.agentOptions, 'agentOptions present: ' + JSON.stringify(spec))
    assert.equal(spec.request.agentOptions.model, 'deepseek-v4-pro')
  } finally { pf.restore() }
})

test('tier_worker keeps an explicit tier choice immune to the decision model', async () => {
  const pf = patchFetch(noulAnswers(0.99))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
    const out = await worker.execute({ task: 'x', tier: 'cheap' }, { agent: main, signal: undefined })
    assert.equal(out.tier, 'cheap')
    assert.equal(pf.calls.length, 0, 'explicit tier must not consult')
  } finally { pf.restore() }
})

test('tier_advisor is skipped when the decision model says no consult is needed', async () => {
  const pf = patchFetch(noulAnswers(0.05))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
    const out = await advisor.execute({ question: 'should I refactor?' }, { agent: main, signal: undefined })
    assert.equal(out.ok, true)
    assert.ok(out.advice.includes('skipped'), out.advice)
    assert.equal(out.model, 'jevens/jev-1.5')
    assert.equal(services.llm.lastStreamOptions, undefined, 'stream must not run for a skipped consult')
  } finally { pf.restore() }
})

test('tier_review is skipped with verdict SKIPPED when the decision model blocks', async () => {
  const pf = patchFetch(noulAnswers(0.05))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const review = services.tools.registered.find((t) => t.name === 'tier_review')
    const out = await review.execute({ focus: 'merge?', evidence: 'tests pass' }, { agent: main, signal: undefined })
    assert.equal(out.verdict, 'SKIPPED')
    assert.equal(out.ok, true)
    assert.equal(services.llm.lastStreamOptions, undefined)
  } finally { pf.restore() }
})

test('plan-exit gate: a skipped advisor review lets the plan through', async () => {
  const pf = patchFetch(noulAnswers(0.05))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const cmd = services.commands.registered.find((c) => c.name === 'tier')
    await cmd.handler({ agent: main, rawInput: 'plan', signal: undefined })
    const guard = ctx.listeners['tools/pre-execute'][0]
    await guard({ agent: main, name: 'read', arguments: { path: 'a.js' } }, async () => {})
    await guard({ agent: main, name: 'read', arguments: { path: 'b.js' } }, async () => {})
    let nextCalled = 0
    const result = await guard({ agent: main, name: 'exit_plan_mode', arguments: { plan: 'do the thing' } }, async () => { nextCalled += 1; return 'ok' })
    assert.equal(result, 'ok')
    assert.equal(nextCalled, 1)
    assert.equal(services.llm.lastStreamOptions, undefined, 'no advisory stream for a skipped review')
  } finally { pf.restore() }
})

test('decision budget per turn caps decision-model calls', async () => {
  const pf = patchFetch(noulAnswers(0.99))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx, { ...DECISION_CFG, decisionBudgetPerTurn: 1 })
    applyAgent(ctx)
    const main = makeAgent('main')
    const route = services.tools.registered.find((t) => t.name === 'tier_route')
    await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
    const guard = ctx.listeners['tools/pre-execute'][0]
    const first = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/a' } }, async () => 'ok')
    assert.equal(first, 'ok', 'first guard deny approved by the decision model')
    const second = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/b' } }, async () => {})
    assert.equal(second.kind, 'deny', 'budget spent: deny without consulting')
    assert.equal(pf.calls.length, 1)
  } finally { pf.restore() }
})

test('identical decision states reuse the response cache (one fetch)', async () => {
  const pf = patchFetch(noulAnswers(0.99))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx)
    applyAgent(ctx)
    const main = makeAgent('main')
    const route = services.tools.registered.find((t) => t.name === 'tier_route')
    await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
    const guard = ctx.listeners['tools/pre-execute'][0]
    const args = { command: 'rm -rf /tmp/same' }
    const a = await guard({ agent: main, name: 'bash', arguments: args }, async () => 'ok')
    const b = await guard({ agent: main, name: 'bash', arguments: args }, async () => 'ok')
    assert.equal(a, 'ok')
    assert.equal(b, 'ok')
    assert.equal(pf.calls.length, 1, 'second identical denial hits the decision cache')
  } finally { pf.restore() }
})

test('decision model off by default: deterministic behavior and zero network traffic', async () => {
  const pf = patchFetch(noulAnswers(0.99))
  try {
    const { ctx, services } = makeContext()
    applyAgent(ctx)
    const main = makeAgent('main')
    const route = services.tools.registered.find((t) => t.name === 'tier_route')
    await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
    const guard = ctx.listeners['tools/pre-execute'][0]
    const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => {})
    assert.equal(result.kind, 'deny')
    for (const fn of ctx.listeners['agent/error']) {
      await fn({ agent: main, error: { message: 'boom' } })
      await fn({ agent: main, error: { message: 'boom' } })
    }
    const status = services.tools.registered.find((t) => t.name === 'tier_status')
    const out = await status.execute({}, { agent: main, signal: undefined })
    assert.ok(out.status.includes('ESCALATED'), out.status)
    assert.equal(pf.calls.length, 0, 'no decision traffic when unconfigured')
  } finally { pf.restore() }
})

test('/tier status reports the decision model configuration and counters', async () => {
  const pf = patchFetch(noulAnswers(0.5))
  try {
    const { ctx, services } = makeContext()
    withDecisionSettings(ctx, { ...DECISION_CFG, decisionStages: ['escalate'] })
    applyAgent(ctx)
    const main = makeAgent('main')
    for (const fn of ctx.listeners['agent/error']) {
      await fn({ agent: main, error: { message: 'boom 1' } })
      await fn({ agent: main, error: { message: 'boom 2' } })
    }
    const cmd = services.commands.registered.find((c) => c.name === 'tier')
    const out = await cmd.handler({ agent: main, rawInput: 'status', signal: undefined })
    assert.ok(out.text.includes('decision model: jevens/jev-1.5'), out.text)
    assert.ok(out.text.includes('stages: escalate'), out.text)
    assert.ok(out.text.includes('decisionCalls=1'), out.text)
  } finally { pf.restore() }
})
test('smart mode pins the main agent to the explicit strong config even with a cheap session model', async () => {
  const { ctx, services } = makeContext()
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'smart' }, { agent: main, signal: undefined })
  const req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-pro', 'the strong tier config decides, not the session picker')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('effective route now: deepseek-official/deepseek-v4-pro'), out.status)
})

test('smart mode respects the configured strong tier after /tier set', async () => {
  const { ctx, services } = makeContext()
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r1 = await cmd.handler({ agent: main, rawInput: 'set strong opencode-go deepseek-v4-flash high', signal: undefined })
  assert.equal(r1.kind, 'success', r1.text)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'smart' }, { agent: main, signal: undefined })
  const req = await runRequest(ctx, main)
  assert.deepEqual([req.provider, req.model], ['opencode-go', 'deepseek-v4-flash'], 'the configured strong tier runs regardless of the session picker')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('effective route now: opencode-go/deepseek-v4-flash'), out.status)
})

test('smart mode in the three-tier layout pins main to its explicit config', async () => {
  const { ctx, services } = makeContext()
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  await cmd.handler({ agent: main, rawInput: 'layout three', signal: undefined })
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'smart' }, { agent: main, signal: undefined })
  let req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-pro', 'plan tier = main uses its explicit config')
  const r2 = await cmd.handler({ agent: main, rawInput: 'set main opencode-go deepseek-v4-flash high', signal: undefined })
  assert.equal(r2.kind, 'success', r2.text)
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-flash', 'main pinned to its explicit config')
})
