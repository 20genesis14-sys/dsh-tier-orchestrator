// Runtime smoke test: loads the real bundle against a mocked DSH 0.2.x
// context, runs apply() on the agent plane, and exercises every tool/command/
// listener path — the agent/request waterfall seam, settings-backed
// persistence, startActivation subagents, fallback chains, task-intensity
// effort, followSession strong tier, effort validation.
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
      stream: async function* () {
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
          result: Promise.resolve({ output: [{ type: 'text', text: 'worker-ok' }], stopReason: 'stop' }),
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
            strongFollowSession: true,
            strongFallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }],
            cheapProvider: options.cheapProvider || 'cctq',
            cheapModel: options.cheapModel || 'gpt-5.6-terra',
            cheapEffort: options.cheapEffort || 'medium',
            cheapFollowSession: false,
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
  assert.deepEqual(names, ['tier_advisor', 'tier_configure', 'tier_escalate_effort', 'tier_review', 'tier_route', 'tier_status', 'tier_worker'])
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
  assert.equal(req.model, 'deepseek-v4-pro', 'plan mode routes strong (followSession -> session selection)')
  main.session.events.push({ type: 'plan/mode', data: { active: false } })
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra')
})

test('strong followSession: session selection drives the strong route', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  const req = await runRequest(ctx, main)
  assert.deepEqual({ provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort }, { provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
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

test('/tier set parses fallback chains and follow-session', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r1 = await cmd.handler({ agent: main, rawInput: 'set cheap cctq gpt-5.6-terra medium --fallback deepseek-official deepseek-v4-flash high', signal: undefined })
  assert.equal(r1.kind, 'success', r1.text)
  assert.ok(r1.text.includes('gpt-5.6-terra'), r1.text)
  assert.ok(r1.text.includes('deepseek-official/deepseek-v4-flash@high'), r1.text)
  const r2 = await cmd.handler({ agent: main, rawInput: 'set strong follow-session', signal: undefined })
  assert.equal(r2.kind, 'success', r2.text)
  assert.ok(r2.text.includes('follows session selection'), r2.text)
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
  assert.equal(patch.cheapFollowSession, false)
  assert.equal(patch.strongFollowSession, true)
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
  // With followSession the descriptions must say the strong tier follows the
  // session selection, not a fixed configured model.
  assert.ok(advisor.description.includes('follows your session model selection'), 'advisor description reflects followSession')
  assert.ok(review.description.includes('follows your session model selection'), 'review description reflects followSession')
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
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const tried = []
  services.llm.stream = async function* (opts) {
    tried.push(opts.provider + '/' + opts.model)
    if (opts.provider === 'cctq') {
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
  assert.deepEqual(tried, ['cctq/gpt-5.6-sol', 'deepseek-official/deepseek-v4-pro'])
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const review = await cmd.handler({ agent: makeAgent('main'), rawInput: 'review the diff', signal: undefined })
  assert.ok(review.text.startsWith('Review (deepseek-official/deepseek-v4-pro):'), review.text)
  assert.deepEqual(tried.slice(2), ['cctq/gpt-5.6-sol', 'deepseek-official/deepseek-v4-pro'])
})

test('consultations stop on failures the main path does not fall back on', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
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
  // strong follows the session (deepseek-v4-pro), cheap is gpt: the reviewer is the session model itself.
  const out = await status.execute({}, { agent: makeAgent('main'), signal: undefined })
  assert.ok(out.status.includes('review: deepseek-official/deepseek-v4-pro (family deepseek) WARNING'), out.status)
  assert.ok(out.status.includes('session model deepseek-official/deepseek-v4-pro'), out.status)
  // No session selection: the reviewer falls back to the explicit strong pair (deepseek), cheap is gpt.
  services.agentDefaultModel.currentSelection = () => null
  const clean = await status.execute({}, { agent: makeAgent('main'), signal: undefined })
  assert.ok(clean.status.includes('(no implementer shares its family)'), clean.status)
})

test('a followed tier tries its explicit pair right after the session model, then its chain', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r = await configure.execute({ tier: 'strong', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r.ok, true, r.message)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  let req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-sol', 'the session model drives the followed strong route')
  for (const fn of ctx.listeners['agent/request-error']) await fn({ agent: main, failure: { message: 'quota', code: 'QUOTA' } }, async () => undefined)
  req = await runRequest(ctx, main)
  assert.deepEqual([req.provider, req.model, req.reasoningEffort], ['opencode-go', 'deepseek-v4-flash', 'high'], 'the explicit pair is the first fallback step')
  for (const fn of ctx.listeners['agent/request-error']) await fn({ agent: main, failure: { message: 'quota', code: 'QUOTA' } }, async () => undefined)
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-pro', 'then the configured chain entry')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('fallback: opencode-go/deepseek-v4-flash@high -> deepseek-official/deepseek-v4-pro@max'), out.status)
})

test('roles route advisor and reviewer on their own model and fall back to the strong route', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
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
  assert.deepEqual(tried, ['cctq/gpt-5.6-sol'], 'roles off: the review uses the strong route')
  tried.length = 0
  const on = await cmd.handler({ agent: main, rawInput: 'roles on', signal: undefined })
  assert.equal(on.kind, 'success', on.text)
  const out = await review.execute({ focus: 'x' }, { agent: main, signal: undefined })
  assert.deepEqual(tried, ['opencode-go/deepseek-v4-flash', 'cctq/gpt-5.6-sol'], 'the role route failed, then the strong route answered')
  assert.deepEqual([out.provider, out.model], ['cctq', 'gpt-5.6-sol'], 'the verdict names the route that answered')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const st = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(st.status.includes('review: opencode-go/deepseek-v4-flash (family deepseek)'), st.status)
  assert.ok(st.status.includes('(no implementer shares its family)'), st.status)
  assert.ok(st.status.includes('review chain: WARNING: fallback cctq/gpt-5.6-sol (family gpt, same as cheap tier)'), 'the chain steps into an implementer family')
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
  await configure.execute({ tier: 'strong', provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max', followSession: false, fallback: [], sessionOnly: true }, { agent: main, signal: undefined })
  await configure.execute({ tier: 'reviewer', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', sessionOnly: true }, { agent: main, signal: undefined })
  await cmd.handler({ agent: main, rawInput: 'roles on', signal: undefined })
  const clean = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(!clean.status.includes('review chain: WARNING'), clean.status)
  assert.ok(clean.status.includes('(no implementer shares its family)'), clean.status)
})

test('three-tier layout: plan runs on main, execution on cheap, escalation on strong', async () => {
  const { ctx, services } = makeContext()
  applyAgent(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'claude-opus-4', reasoningEffort: 'high' })
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r = await configure.execute({ tier: 'strong', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', followSession: false, sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r.ok, true, r.message)
  const layout = await cmd.handler({ agent: main, rawInput: 'layout three', signal: undefined })
  assert.equal(layout.kind, 'success', layout.text)
  let req = await runRequest(ctx, main)
  assert.equal(req.model, 'gpt-5.6-terra', 'execution routes to the cheap tier')
  main.session.events.push({ type: 'plan/mode', data: { active: true } })
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'claude-opus-4', 'plan mode runs on the main tier (session-followed)')
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'boom 1' } })
    await fn({ agent: main, error: { message: 'boom 2' } })
  }
  req = await runRequest(ctx, main)
  assert.equal(req.model, 'deepseek-v4-flash', 'repeated errors escalate to the strong tier')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('layout: three tiers'), out.status)
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
  const m = await configure.execute({ tier: 'main', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', followSession: false, sessionOnly: true }, { agent: main, signal: undefined })
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
