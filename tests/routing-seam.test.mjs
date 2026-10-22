// Adapter tests for lib/dsh/routing-seam.js — both strategy generations
// (agent/request waterfall and the legacy request/header write) run here
// against plain fakes, so a contract change is caught without a live host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mountRequestWaterfall, headerOf, headerConfigOf, writeHeaderRoute, applyHeaderRoute,
} from '../lib/dsh/routing-seam.js'

function fakeSession(initial) {
  const writes = []
  let header = initial || null
  return {
    writes,
    append(kind, payload) {
      writes.push({ kind, payload })
      if (kind === 'request/header') header = payload.header
    },
    requestHeader() { return header },
  }
}

function fakeCtx() {
  const listeners = {}
  return {
    listeners,
    on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn) },
  }
}

function diag() { return { requestSteps: 0, headerWrites: 0, lastRouting: '', lastHeader: '' } }

test('the waterfall returns the seed untouched when resolve declines', async () => {
  const ctx = fakeCtx()
  const d = diag()
  assert.equal(mountRequestWaterfall(ctx, async () => null, d), true)
  const seed = { provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 10 }
  const out = await ctx.listeners['agent/request'][0]({ agent: { id: 'a' } }, async () => seed)
  assert.equal(out, seed)
  assert.equal(d.requestSteps, 1)
})

test('the waterfall returns the routed config and keeps unrelated fields', async () => {
  const ctx = fakeCtx()
  const d = diag()
  mountRequestWaterfall(ctx, async () => ({ provider: 'p2', model: 'm2', reasoningEffort: 'low' }), d)
  const seed = { provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 10, stop: ['x'] }
  const out = await ctx.listeners['agent/request'][0]({ agent: { id: 'a' } }, async () => seed)
  assert.deepEqual(out, { provider: 'p2', model: 'm2', reasoningEffort: 'low', maxTokens: 10, stop: ['x'] })
  assert.equal(d.lastRouting, 'request #1: p/m -> p2/m2 (low)')
})

test('an undefined effort is a decision: the seed effort is dropped', async () => {
  const ctx = fakeCtx()
  mountRequestWaterfall(ctx, async () => ({ provider: 'p2', model: 'm2' }), diag())
  const seed = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const out = await ctx.listeners['agent/request'][0]({ agent: { id: 'a' } }, async () => seed)
  assert.equal('reasoningEffort' in out, false)
})

test('the waterfall preserves the seed when resolve throws or next fails', async () => {
  const ctx = fakeCtx()
  const d = diag()
  mountRequestWaterfall(ctx, async () => { throw new Error('boom') }, d)
  const seed = { provider: 'p', model: 'm' }
  const out = await ctx.listeners['agent/request'][0]({ agent: { id: 'a' } }, async () => seed)
  assert.equal(out, seed)
  assert.ok(d.lastRouting.includes('boom'))

  const broken = fakeCtx()
  mountRequestWaterfall(broken, async () => ({ provider: 'p2', model: 'm2' }), diag())
  await assert.rejects(
    () => broken.listeners['agent/request'][0]({ agent: { id: 'a' } }, async () => { throw new Error('loop broke') }),
    /loop broke/,
  )
})

test('the waterfall declines to mount without a listener seam', () => {
  assert.equal(mountRequestWaterfall({}, async () => null, diag()), false)
  assert.equal(mountRequestWaterfall({ on() { throw new Error('no seam') } }, async () => null, diag()), false)
})

test('writeHeaderRoute never appends an undefined effort', () => {
  const session = fakeSession(null)
  const agent = { id: 'a1', session }
  assert.equal(writeHeaderRoute(agent, { provider: 'p', model: 'm' }), true)
  const config = session.writes[0].payload.header.config
  assert.equal('reasoningEffort' in config, false, 'no undefined effort reaches the session append')
  assert.equal(config.provider, 'p')
  assert.equal(session.writes[0].kind, 'request/header')
  assert.equal(session.writes[0].payload.reason, 'change')
})

test('writeHeaderRoute keeps unrelated header fields and skips an identical route', () => {
  const session = fakeSession({ config: { provider: 'p', model: 'm', maxTokens: 42, temperature: 0.2 } })
  const agent = { id: 'a1', session }
  assert.equal(writeHeaderRoute(agent, { provider: 'p', model: 'm' }), false, 'identical route is not rewritten')
  assert.equal(writeHeaderRoute(agent, { provider: 'p', model: 'm', reasoningEffort: 'max' }), true)
  const config = session.writes[0].payload.header.config
  assert.equal(config.maxTokens, 42)
  assert.equal(config.temperature, 0.2)
  assert.equal(config.reasoningEffort, 'max')
})

test('writeHeaderRoute reports a failed append instead of throwing', () => {
  const d = diag()
  const agent = { id: 'a1', session: { append() { throw new Error('closed turn') }, requestHeader: () => null } }
  assert.equal(writeHeaderRoute(agent, { provider: 'p', model: 'm' }, d), false)
  assert.ok(d.lastHeader.includes('closed turn'))
})

test('applyHeaderRoute keeps agent.options and the durable header in sync', () => {
  const session = fakeSession(null)
  const agent = { id: 'a1', options: { provider: 'p', model: 'm', reasoningEffort: 'high' }, session }
  applyHeaderRoute(agent, { provider: 'p2', model: 'm2', reasoningEffort: 'low' }, diag())
  assert.deepEqual(agent.options, { provider: 'p2', model: 'm2', reasoningEffort: 'low' })
  assert.equal(session.writes.length, 1)
})

test('applyHeaderRoute drops a stale effort when the target declares none', () => {
  const session = fakeSession(null)
  const agent = { id: 'a1', options: { provider: 'p', model: 'm', reasoningEffort: 'max' }, session }
  applyHeaderRoute(agent, { provider: 'p2', model: 'm2' }, diag())
  assert.equal('reasoningEffort' in agent.options, false, 'the first/resumed request is not built from the old effort')
  assert.equal(agent.options.model, 'm2')
})

test('header readers degrade instead of throwing', () => {
  assert.equal(headerOf(undefined), undefined)
  assert.equal(headerOf({ requestHeader() { throw new Error('x') } }), undefined)
  assert.equal(headerConfigOf({ requestHeader: () => ({ config: { provider: 'p' } }) }).provider, 'p')
  assert.equal(headerConfigOf({ requestHeader: () => null }), undefined)
})
