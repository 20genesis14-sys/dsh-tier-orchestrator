// Transport tests for the decision-model client (lib/dsh/decisions.js).
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionClient } from '../lib/dsh/decisions.js'
import { noulQuestion, choiceQuestion } from '../lib/core/decision.js'

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url, opts })
    const body = JSON.parse(opts.body)
    const value = await handler(body, url, opts)
    return { ok: true, status: 200, json: async () => value }
  }
  return { impl, calls }
}

const Q = { safe: noulQuestion('is it safe?') }

test('client posts {model,state,questions} with bearer auth and maps thresholds', async () => {
  const ff = fakeFetch((body) => ({ answers: { safe: { type: 'noul', noul: 0.95 } } }))
  const client = createDecisionClient({ model: 'jevens/jev-1.5', apiKey: 'sk-test', fetchImpl: ff.impl })
  const out = await client.ask(Q, { tier: 'cheap', tool: 'bash' })
  assert.equal(out.ok, true)
  assert.equal(out.outcome, 'approve')
  assert.equal(out.values.safe, 0.95)
  assert.equal(ff.calls.length, 1)
  const sent = JSON.parse(ff.calls[0].opts.body)
  assert.equal(sent.model, 'jevens/jev-1.5')
  assert.deepEqual(sent.state, { tier: 'cheap', tool: 'bash' })
  assert.ok(sent.questions.safe)
  assert.equal(ff.calls[0].opts.headers.authorization, 'Bearer sk-test')
  assert.match(ff.calls[0].url, /^https:\/\/openrouter\.ai\/api\/alpha\/decisions$/)
})

test('identical state+questions reuse the cache without a second request', async () => {
  const ff = fakeFetch(() => ({ answers: { safe: { type: 'noul', noul: 0.95 } } }))
  const client = createDecisionClient({ model: 'm', fetchImpl: ff.impl })
  const first = await client.ask(Q, { tier: 'cheap' })
  const second = await client.ask(Q, { tier: 'cheap' })
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.outcome, 'approve')
  assert.equal(ff.calls.length, 1)
})

test('cache is invalidated by a different state', async () => {
  const ff = fakeFetch(() => ({ answers: { safe: { type: 'noul', noul: 0.95 } } }))
  const client = createDecisionClient({ model: 'm', fetchImpl: ff.impl })
  await client.ask(Q, { tier: 'cheap' })
  await client.ask(Q, { tier: 'strong' })
  assert.equal(ff.calls.length, 2)
})

test('choice answers carry confidence into probabilities', async () => {
  const ff = fakeFetch(() => ({ answers: { tier: { type: 'choice', choice: 'strong', confidence: 0.95 } } }))
  const client = createDecisionClient({ model: 'm', fetchImpl: ff.impl })
  const out = await client.ask({ tier: choiceQuestion('which?', { cheap: 'c', strong: 's' }) }, {})
  assert.equal(out.ok, true)
  assert.equal(out.values.tier, 'strong')
  assert.equal(out.outcome, 'approve')
})

test('endpoint errors never throw: network failure, non-JSON, HTTP 500', async () => {
  const net = createDecisionClient({ model: 'm', fetchImpl: async () => { throw new Error('ECONNRESET') } })
  const n = await net.ask(Q, {})
  assert.equal(n.ok, false)
  assert.equal(n.outcome, 'unknown')
  assert.ok(n.reason.includes('failed'))

  const badJson = createDecisionClient({ model: 'm', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }) })
  const b = await badJson.ask(Q, {})
  assert.equal(b.ok, false)

  const http500 = createDecisionClient({ model: 'm', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }) })
  const h = await http500.ask(Q, {})
  assert.equal(h.ok, false)
  assert.ok(h.reason.includes('500'))
})

test('strict parsing rejects malformed answers instead of reading them as approvals', async () => {
  const malformed = createDecisionClient({ model: 'm', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ answers: { safe: { type: 'noul', noul: 'yes' } } }) }) })
  const out = await malformed.ask(Q, {})
  assert.equal(out.ok, false)
  assert.equal(out.outcome, 'unknown')
})

test('no model configured fails closed without touching the network', async () => {
  let called = false
  const client = createDecisionClient({ fetchImpl: async () => { called = true; throw new Error('should not be called') } })
  const out = await client.ask(Q, {})
  assert.equal(out.ok, false)
  assert.equal(out.outcome, 'unknown')
  assert.equal(called, false)
})

test('request timeouts abort and fail closed', async () => {
  const hanging = createDecisionClient({
    model: 'm',
    timeoutMs: 50,
    fetchImpl: (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  const out = await hanging.ask(Q, {})
  assert.equal(out.ok, false)
  assert.equal(out.outcome, 'unknown')
})