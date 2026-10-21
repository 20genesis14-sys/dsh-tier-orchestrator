// Unit tests for the pure core logic of dsh-tier-router (no harness required).
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHighImpact, hasRecursiveForceRm } from '../lib/core/guard.js'
import { resolveTierSpec, classifyFallback, validateReasoningEffort, nextEffortStep, fallbackActive, advanceFallback, migrateTierConfig, reconcileReasoningEffort, EFFORT_LADDER, DEFAULT_TIER_CONFIG, FALLBACK_TRIGGER_CODES, FALLBACK_IGNORE_CODES, attemptChain } from '../lib/core/routing.js'
import { escalationStep, escalationActive, escalationExpired, decideGuardAction, decideErrorActions, decidePlanExit } from '../lib/core/policy.js'
import { consultSpec, CONSULTS, modelFamily, reviewerConflicts } from '../lib/core/consult.js'
import { childRouteSource, cappedTier } from '../lib/core/routing.js'
import { createTierRegistry, tierLabel, chainText, TIER_ORDER } from '../lib/core/tiers.js'
import { embedCodeText, rotateVector, createTurboQuantIndex, TURBO_LEVELS } from '../lib/core/turbovec.js'
import { sidekickSpec, resolveSidekickTarget, parseExploreSnippets, parseChangeReport, formatCard, SIDEKICK_STAGES } from '../lib/core/sidekick.js'
import { decideAdvisorBudget } from '../lib/core/policy.js'
import { softParseSections } from '../lib/core/consult.js'

// ---- rm -rf detection (including split flags) -----------------------------

test('detects recursive-force rm in all spellings', () => {
  assert.ok(hasRecursiveForceRm('rm -rf /tmp/x'))
  assert.ok(hasRecursiveForceRm('echo hi; rm -rf ~/.cache'))
  assert.ok(hasRecursiveForceRm('rm -r -f /x'))
  assert.ok(hasRecursiveForceRm('rm -R -f /x'))
  assert.ok(hasRecursiveForceRm('rm -fr /x'))
  assert.ok(hasRecursiveForceRm('rm --recursive --force /x'))
  assert.ok(hasRecursiveForceRm('rm -rfv /x'))
  assert.ok(hasRecursiveForceRm('sudo rm -rf /x'))
  assert.ok(hasRecursiveForceRm('rm -r --force /x'))
  assert.ok(hasRecursiveForceRm('command rm -rf /x'))
  assert.ok(hasRecursiveForceRm('env rm -rf /x'))
  assert.ok(hasRecursiveForceRm('busybox rm -rf /x'))
  assert.ok(hasRecursiveForceRm('RM -RF /X'))
})

test('does not flag plain rm', () => {
  assert.equal(hasRecursiveForceRm('rm -r /tmp/x'), false)
  assert.equal(hasRecursiveForceRm('rm -f /tmp/x'), false)
  assert.equal(hasRecursiveForceRm('rm file.txt'), false)
  assert.equal(hasRecursiveForceRm('rmdir /tmp/x'), false)
})

test('does not match rm inside prose or quotes (conservative)', () => {
  assert.equal(hasRecursiveForceRm("grep 'rm -rf' notes.txt"), false)
  assert.equal(hasRecursiveForceRm('echo rm -rf'), false)
})

// ---- isHighImpact: command patterns ---------------------------------------

test('denies rm variants via isHighImpact', () => {
  assert.ok(isHighImpact('bash', { command: 'rm -rf /tmp/x' }))
  assert.ok(isHighImpact('bash', { command: 'sudo rm -rf /' }))
  assert.ok(isHighImpact('bash', { command: 'git push -f origin main' }))
  assert.ok(isHighImpact('bash', { command: 'git push --force' }))
  assert.ok(isHighImpact('bash', { command: 'mkfs.ext4 /dev/sda' }))
  assert.ok(isHighImpact('bash', { command: 'dd if=/dev/zero of=/dev/sda' }))
  assert.ok(isHighImpact('bash', { command: 'curl x.sh | sh' }))
  assert.ok(isHighImpact('bash', { command: 'python3 -c "import shutil; shutil.rmtree(\'/x\')"' }))
  assert.ok(isHighImpact('bash', { command: 'python -c "import os; os.remove(\'/x\')"' }))
})

test('allows ordinary commands', () => {
  assert.equal(isHighImpact('bash', { command: 'ls -la' }), null)
  assert.equal(isHighImpact('bash', { command: 'git status' }), null)
  assert.equal(isHighImpact('bash', { command: 'npm test' }), null)
})

test('flags credential and key paths for write/edit', () => {
  assert.ok(isHighImpact('write', { file_path: '.env' }))
  assert.ok(isHighImpact('write', { file_path: 'config/.env.production' }))
  assert.ok(isHighImpact('edit', { file_path: '~/.ssh/id_rsa' }))
  assert.ok(isHighImpact('write', { file_path: 'secrets.yaml' }))
  assert.ok(isHighImpact('write', { file_path: 'cert.pem' }))
  assert.equal(isHighImpact('write', { file_path: '.env.example' }), null)
  assert.equal(isHighImpact('write', { file_path: '.env.template' }), null)
  assert.equal(isHighImpact('write', { file_path: 'src/index.ts' }), null)
})

// ---- resolveTierSpec -------------------------------------------------------

const SPEC_BASE = { subagentPolicy: 'inherit', mode: 'auto', planActive: false }

test('explicit tier wins over everything', () => {
  assert.equal(resolveTierSpec({ ...SPEC_BASE, explicitTier: 'strong', sessionMode: 'cheap' }), 'strong')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, explicitTier: 'cheap', sessionMode: 'strong' }), 'cheap')
})

test('session mode off returns null (no routing)', () => {
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'off' }), null)
})

test('explicit session tier overrides auto', () => {
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'strong' }), 'strong')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'cheap' }), 'cheap')
})

test('auto mode: plan -> strong, execution -> cheap', () => {
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'auto', planActive: true }), 'strong')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'auto', planActive: false }), 'cheap')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, planActive: true }), 'strong')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, planActive: false }), 'cheap')
})

test('escalation routes to the strong tier', () => {
  assert.equal(resolveTierSpec({ ...SPEC_BASE, escalated: true }), 'strong')
})

test('subagent policy routes children', () => {
  assert.equal(resolveTierSpec({ ...SPEC_BASE, isChild: true, subagentPolicy: 'strong' }), 'strong')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, isChild: true, subagentPolicy: 'cheap' }), 'cheap')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, isChild: true, subagentPolicy: 'inherit' }), 'cheap')
})

test('delegated: main unrouted, children tiered by plan state', () => {
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'delegated', isChild: false }), null)
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'delegated', isChild: true, planActive: true }), 'strong')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, sessionMode: 'delegated', isChild: true, planActive: false }), 'cheap')
})

// ---- fallback classification ------------------------------------------------

test('classifyFallback: trigger codes switch the model', () => {
  for (const code of FALLBACK_TRIGGER_CODES) {
    assert.equal(classifyFallback({ code }), 'fallback', code)
  }
  assert.equal(classifyFallback({ status: 503 }), 'fallback')
})

test('classifyFallback: non-model causes are ignored', () => {
  for (const code of FALLBACK_IGNORE_CODES) {
    assert.equal(classifyFallback({ code }), 'ignore', code)
  }
})

test('classifyFallback: unknown shapes keep escalation behavior', () => {
  assert.equal(classifyFallback({ message: 'weird' }), 'escalate')
  assert.equal(classifyFallback(null), 'escalate')
})

test('classifyFallback: an unregistered provider route falls back (llm NO_ADAPTER)', () => {
  assert.equal(classifyFallback({ code: 'NO_ADAPTER' }), 'fallback')
})

test('attemptChain: primary first, then the chain, without identical repeats', () => {
  const primary = { provider: 'a', model: 'pro', reasoningEffort: 'max' }
  const chain = [{ provider: 'a', model: 'pro', reasoningEffort: 'max' }, { provider: 'b', model: 'flash', reasoningEffort: 'high' }]
  assert.deepEqual(attemptChain(primary, chain).map((t) => t.provider + '/' + t.model), ['a/pro', 'b/flash'])
  assert.deepEqual(attemptChain(primary, []).length, 1)
  assert.deepEqual(attemptChain(primary, [{ provider: 'a', model: 'pro', reasoningEffort: 'high' }]).length, 2, 'same model with another effort is a distinct route')
  assert.deepEqual(attemptChain(primary, undefined), [primary])
})

// ---- effort validation / ladder ----------------------------------------------

test('validateReasoningEffort honors declared effort ids', () => {
  assert.equal(validateReasoningEffort('high', ['off', 'high', 'max']).ok, true)
  assert.equal(validateReasoningEffort('medium', ['off', 'high', 'max']).ok, false)
  assert.equal(validateReasoningEffort('medium', []).ok, true, 'lenient without declarations')
  assert.equal(validateReasoningEffort('', ['high']).ok, false)
})

test('nextEffortStep walks the ladder within declared ids', () => {
  assert.equal(nextEffortStep('medium', ['off', 'high', 'max']), 'high')
  assert.equal(nextEffortStep('high', ['off', 'high', 'max']), 'max')
  assert.equal(nextEffortStep('max', ['off', 'high', 'max']), null)
  assert.equal(nextEffortStep('high', ['low', 'medium', 'high']), null, 'cctq has no max')
  assert.equal(nextEffortStep('medium', ['low', 'medium', 'high']), 'high')
})

// ---- fallback records ----------------------------------------------------------

test('fallbackActive requires an active chain position within its TTL', () => {
  assert.equal(fallbackActive({ index: -1, until: Date.now() + 1000 }, Date.now()), false)
  assert.equal(fallbackActive({ index: 0, until: Date.now() + 1000 }, Date.now()), true)
  assert.equal(fallbackActive({ index: 0, until: Date.now() - 1 }, Date.now()), false)
  assert.equal(fallbackActive(null, Date.now()), false)
})

test('advanceFallback walks the chain and exhausts', () => {
  const chain = [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }]
  const now = 1000
  const s1 = advanceFallback({ index: -1, until: 0 }, chain, now, 60000)
  assert.equal(s1.index, 0)
  const s2 = advanceFallback(s1, chain, now, 60000)
  assert.equal(s2.index, 1)
  assert.equal(advanceFallback(s2, chain, now, 60000), null, 'chain exhausted')
})

// ---- migrateTierConfig ---------------------------------------------------------

test('migrateTierConfig fills defaults and migrates legacy entries', () => {
  const d = migrateTierConfig('cheap', null)
  assert.equal(d.provider, 'deepseek-official')
  assert.equal(d.model, 'deepseek-v4-flash')
  assert.equal(d.followSession, false)
  const legacy = migrateTierConfig('strong', { provider: 'x', model: 'y', reasoningEffort: 'high' })
  assert.equal(legacy.followSession, true)
  assert.deepEqual(legacy.fallback, [{ provider: 'x', model: 'y', reasoningEffort: 'high' }], 'legacy config mirrors primary as the fallback')
  const explicit = migrateTierConfig('cheap', { provider: 'x', model: 'y', reasoningEffort: 'low', fallback: [] })
  assert.deepEqual(explicit.fallback, [], 'empty array is a real chain, not legacy')
})

test('defaults: strong follows session, cheap is deepseek-v4-flash at low effort', () => {
  assert.equal(DEFAULT_TIER_CONFIG.strong.followSession, true)
  assert.equal(DEFAULT_TIER_CONFIG.cheap.model, 'deepseek-v4-flash')
  assert.equal(DEFAULT_TIER_CONFIG.cheap.reasoningEffort, 'low')
  assert.deepEqual(EFFORT_LADDER, ['low', 'medium', 'high', 'max'])
})

test('reconcileReasoningEffort omits effort when the model declares no reasoning', () => {
  const r = reconcileReasoningEffort('medium', undefined)
  assert.equal(r.effort, undefined, 'a model without reasoning metadata must receive no effort')
  assert.match(r.reason, /no reasoning support/)
  assert.deepEqual(reconcileReasoningEffort(undefined, undefined), { effort: undefined, reason: null })
})

test('reconcileReasoningEffort substitutes an undeclared effort with a declared one', () => {
  const deepseek = { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] }
  const r = reconcileReasoningEffort('medium', deepseek)
  assert.equal(r.effort, 'low')
  assert.match(r.reason, /not declared/)
  assert.equal(reconcileReasoningEffort('max', deepseek).effort, 'max')
  assert.equal(reconcileReasoningEffort('max', deepseek).reason, null)
})

test('reconcileReasoningEffort prefers the model default then the lowest declared', () => {
  const defaulted = { efforts: [{ id: 'high' }, { id: 'max' }], defaultEffort: 'max' }
  assert.equal(reconcileReasoningEffort('medium', defaulted).effort, 'max')
  const noDefault = { efforts: [{ id: 'high' }, { id: 'max' }] }
  assert.equal(reconcileReasoningEffort('medium', noDefault).effort, 'high')
  assert.equal(reconcileReasoningEffort('low', { efforts: [] }).effort, 'low', 'lenient without ids')
})

// ---- policy: escalation state machine -------------------------------------------

test('escalationStep counts errors in a window and opens a TTL escalation', () => {
  let r = escalationStep(undefined, 1000, { threshold: 2, windowMs: 60000, ttlMs: 180000 })
  assert.equal(r.escalated, false)
  assert.equal(r.rec.count, 1)
  r = escalationStep(r.rec, 2000, { threshold: 2, windowMs: 60000, ttlMs: 180000 })
  assert.equal(r.escalated, true)
  assert.equal(r.rec.until, 2000 + 180000)
  assert.equal(escalationActive(r.rec, 3000), true)
  assert.equal(escalationActive(r.rec, 2000 + 180001), false)
  assert.equal(escalationExpired(r.rec, 2000 + 180001), true)
})

test('escalationStep resets the counter outside the window', () => {
  let r = escalationStep(undefined, 0, { threshold: 2, windowMs: 1000, ttlMs: 5000 })
  r = escalationStep(r.rec, 5000, { threshold: 2, windowMs: 1000, ttlMs: 5000 })
  assert.equal(r.escalated, false, 'second error outside the window restarts the count')
  assert.equal(r.rec.count, 1)
})

test('decideGuardAction denies only on the weak tier with a hit', () => {
  assert.equal(decideGuardAction('cheap', 'hit', 'cheap').action, 'deny')
  assert.equal(decideGuardAction('strong', 'hit', 'cheap').action, 'allow')
  assert.equal(decideGuardAction('cheap', null, 'cheap').action, 'allow')
})

test('decidePlanExit: explore first, one advisor review, then allow', () => {
  const base = { planActive: true, explored: 0, minExplore: 2, advisorGate: true, consulted: false }
  assert.equal(decidePlanExit({ ...base, planActive: false }).action, 'allow', 'outside plan mode the gate is silent')
  const early = decidePlanExit(base)
  assert.equal(early.action, 'deny')
  assert.ok(early.reason.includes('explore before presenting the plan'))
  assert.equal(decidePlanExit({ ...base, explored: 2 }).action, 'consult')
  assert.equal(decidePlanExit({ ...base, explored: 2, consulted: true }).action, 'allow')
  assert.equal(decidePlanExit({ ...base, explored: 2, advisorGate: false }).action, 'allow')
  assert.equal(decidePlanExit({ ...base, minExplore: 0, advisorGate: false }).action, 'allow', 'minExplore 0 disables the explore check')
})

test('decideErrorActions escalates at the threshold and raises cheap effort otherwise', () => {
  const opts = { threshold: 2, windowMs: 60000, ttlMs: 180000 }
  const first = decideErrorActions({ message: 'x', code: 'TIMEOUT' }, undefined, 'cheap', 'cheap', { ...opts, now: 1000 })
  assert.deepEqual(first.actions, ['raise-effort'])
  const second = decideErrorActions({ message: 'y', code: 'TIMEOUT' }, first.rec, 'cheap', 'cheap', { ...opts, now: 2000 })
  assert.deepEqual(second.actions, ['escalate'])
  const ignored = decideErrorActions({ code: 'ABORTED' }, undefined, 'cheap', 'cheap', { ...opts, now: 3000 })
  assert.deepEqual(ignored.actions, [])
})

// ---- consult registry ------------------------------------------------------------

test('modelFamily groups routes of one model lineage across providers', () => {
  assert.equal(modelFamily('deepseek-v4-pro'), 'deepseek')
  assert.equal(modelFamily('deepseek-ai/DeepSeek-V3'), 'deepseek')
  assert.equal(modelFamily('minimax/minimax-m3.1-flash'), 'minimax')
  assert.equal(modelFamily('gpt-5.6-terra'), 'gpt')
  assert.equal(modelFamily('claude-opus-4'), 'claude')
})

test('reviewerConflicts flags only same-family implementers', () => {
  const reviewer = { provider: 'opencode-go', model: 'deepseek-v4-pro' }
  const implementers = [
    { label: 'cheap tier', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    { label: 'session model', provider: 'cctq', model: 'gpt-5.6-terra' },
  ]
  assert.deepEqual(reviewerConflicts(reviewer, implementers).map((i) => i.label), ['cheap tier'])
  assert.deepEqual(reviewerConflicts({ provider: 'cctq', model: 'claude-opus-4' }, implementers), [])
})

test('consult registry carries advisor and review specs', () => {
  assert.ok(CONSULTS.advisor.system.includes('Tier Advisor'))
  assert.ok(CONSULTS.review.system.includes('Tier Reviewer'))
  assert.equal(consultSpec('advisor').buildUser({ question: 'q', evidence: 'e' }), 'Decision question:\nq\n\nEvidence:\ne')
  const parsed = consultSpec('review').parse('APPROVE\nall good', true)
  assert.equal(parsed.verdict, 'APPROVE')
  assert.equal(consultSpec('review').parse('hmm', true).verdict, 'UNPARSED')
  assert.equal(consultSpec('review').parse('', false).verdict, 'FAILED')
})

// ---- tier registry -----------------------------------------------------------------

test('childRouteSource: pins and escalation win, then an explicit route, then caller', () => {
  const base = { pinned: false, escalated: false, explicit: false, policy: 'inherit', hasParentRoute: true }
  assert.equal(childRouteSource({ ...base, policy: 'caller' }), 'parent')
  assert.equal(childRouteSource({ ...base, policy: 'caller', hasParentRoute: false }), 'tier', 'no parent route: fall back to the tier decision')
  assert.equal(childRouteSource({ ...base, explicit: true, policy: 'caller' }), 'keep', 'an explicit route beats caller')
  assert.equal(childRouteSource({ ...base, explicit: true, escalated: true }), 'tier', 'escalation outranks an explicit route')
  assert.equal(childRouteSource({ ...base, explicit: true, pinned: true }), 'tier', 'a tier_worker pin outranks an explicit route')
  assert.equal(childRouteSource({ ...base, policy: 'cheap' }), 'tier')
})

test('capped policy: the parent tier, never stronger than the cap', () => {
  const three = ['strong', 'main', 'cheap']
  assert.equal(cappedTier('strong', 'main', three), 'main', 'a strong parent is capped at main')
  assert.equal(cappedTier('main', 'main', three), 'main')
  assert.equal(cappedTier('cheap', 'main', three), 'cheap', 'a weaker parent is kept')
  assert.equal(cappedTier('strong', 'cheap', ['strong', 'cheap']), 'cheap', 'two tiers: a strong parent is capped at cheap')
  assert.equal(cappedTier(null, 'main', three), null, 'a parent without a tier keeps its baseline')
  assert.equal(childRouteSource({ pinned: false, escalated: false, explicit: false, policy: 'capped', hasParentRoute: true }), 'capped')
  assert.equal(childRouteSource({ pinned: false, escalated: false, explicit: false, policy: 'capped', hasParentRoute: false }), 'tier')
})

test('three tiers: plan runs on main, strong is reached by escalation or a pin', () => {
  const three = { subagentPolicy: 'inherit', mode: 'auto', tiers: ['strong', 'main', 'cheap'] }
  assert.equal(resolveTierSpec({ ...three, planActive: true }), 'main')
  assert.equal(resolveTierSpec({ ...three, planActive: false }), 'cheap')
  assert.equal(resolveTierSpec({ ...three, planActive: false, escalated: true }), 'strong')
  assert.equal(resolveTierSpec({ ...three, planActive: false, sessionMode: 'strong' }), 'strong')
  assert.equal(resolveTierSpec({ ...three, planActive: false, sessionMode: 'main' }), 'main')
  assert.equal(resolveTierSpec({ ...SPEC_BASE, planActive: true, tiers: ['strong', 'cheap'] }), 'strong', 'two tiers: plan stays on strong')
})

test('main defaults follow the session model at high effort', () => {
  assert.equal(DEFAULT_TIER_CONFIG.main.followSession, true)
  assert.equal(migrateTierConfig('main', null).reasoningEffort, 'high')
})

test('tier registry orders strong first and cheap last', () => {
  const reg = createTierRegistry(null)
  assert.deepEqual(reg.names(), TIER_ORDER)
  assert.equal(reg.first(), 'strong')
  assert.equal(reg.last(), 'cheap')
  assert.equal(reg.get('cheap').model, 'deepseek-v4-flash')
  reg.set('cheap', migrateTierConfig('cheap', { provider: 'x', model: 'y', reasoningEffort: 'high' }))
  assert.equal(tierLabel(reg.get('cheap')), 'x/y (high)')
  assert.equal(chainText(reg.get('cheap')), 'x/y@high')
  const snap = reg.snapshot()
  assert.equal(snap.strong.followSession, true)
})

// ---- turbovec: local embedding + 4-bit TurboQuant index -------------------

test('embedCodeText produces a deterministic unit-norm vector', () => {
  const a = embedCodeText('function getId() { return this.id }', 512)
  const b = embedCodeText('function getId() { return this.id }', 512)
  assert.equal(a.length, 512)
  assert.equal(a.constructor, Float32Array)
  assert.deepEqual(Array.from(a), Array.from(b))
  let sum = 0
  for (let i = 0; i < 512; i++) sum += a[i] * a[i]
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5, 'unit norm')
  const zero = embedCodeText('', 512)
  assert.equal(zero.length, 512)
})

test('embedCodeText separates distinct code documents', () => {
  const a = embedCodeText('export function parseRequest(req) { return req.body }', 512)
  const b = embedCodeText('class Renderer { render(node) { return node.text } }', 512)
  let dot = 0
  for (let i = 0; i < 512; i++) dot += a[i] * b[i]
  assert.ok(dot < 0.4, 'different documents are not strongly aligned: ' + dot)
})

test('rotateVector preserves inner products up to the FWHT scale factor', () => {
  const a = embedCodeText('const x = computeHash(input)', 512)
  const b = embedCodeText('const y = computeHash(input)', 512)
  const ra = rotateVector(a, 512)
  const rb = rotateVector(b, 512)
  let dotAB = 0
  let dotR = 0
  for (let i = 0; i < 512; i++) {
    dotAB += a[i] * b[i]
    dotR += ra[i] * rb[i]
  }
  assert.ok(Math.abs(dotR - 512 * dotAB) < 1e-3 * 512, 'dot scaled by n: ' + dotR + ' vs ' + (512 * dotAB))
})

test('TurboQuant stores 256 bytes per vector at d=512', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: '1', path: 'src/a.ts', lines: '1-10', snippet: 'export function parseRequest(req) { return req.body }', stage: 'explore' })
  const st = idx.stats()
  assert.equal(st.bytes, 256)
  assert.equal(st.entries, 1)
  assert.equal(TURBO_LEVELS.length, 16)
  assert.ok(TURBO_LEVELS[0] < TURBO_LEVELS[15], 'levels ascending')
})

test('TurboQuant search finds the relevant snippet', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 'parse', path: 'src/parser.ts', lines: '1-25', snippet: 'export function parseRequest(req) { return req.body }', stage: 'explore' })
  idx.upsert({ id: 'render', path: 'src/renderer.ts', lines: '3-30', snippet: 'class Renderer { render(node) { return node.text } }', stage: 'explore' })
  const hits = idx.search('parseRequest body', { k: 1, minScore: 0.1 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'parse')
  assert.ok(hits[0].score > 0.1, 'score ' + hits[0].score)
  const miss = idx.search('zzz qqq www unknown', { k: 5, minScore: 0.5 })
  assert.equal(miss.length, 0)
})

test('TurboQuant pathFilter restricts results', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 'a', path: 'src/a.ts', lines: '1', snippet: 'export function parseRequest(req) { return req.body }' })
  idx.upsert({ id: 'b', path: 'src/b.ts', lines: '1', snippet: 'export function parseRequest(req) { return req.body }' })
  const hits = idx.search('parseRequest', { k: 5, pathFilter: 'src/a.ts' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, 'src/a.ts')
})

test('TurboQuant invalidateByPath removes the file snippets', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 'a', path: 'src/a.ts', lines: '1-10', snippet: 'export function parseRequest(req) { return req.body }' })
  idx.upsert({ id: 'c', path: 'src/c.ts', lines: '1-10', snippet: 'export function parseRequest(req) { return req.body }' })
  assert.equal(idx.stats().entries, 2)
  const removed = idx.invalidateByPath('src/a.ts')
  assert.equal(removed, 1)
  assert.equal(idx.stats().entries, 1)
  const hits = idx.search('parseRequest', { k: 5, minScore: 0.05 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'c')
})

test('TurboQuant upsert refreshes an existing path+lines entry', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 'a', path: 'src/a.ts', lines: '1-10', snippet: 'old code', updatedAt: 1 })
  const refreshed = idx.upsert({ id: 'a', path: 'src/a.ts', lines: '1-10', snippet: 'new code', updatedAt: 2 })
  assert.equal(idx.stats().entries, 1)
  assert.equal(refreshed.snippet, 'new code')
  assert.equal(refreshed.updatedAt, 2)
})

test('TurboQuant export/import round-trip preserves search', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 'parse', path: 'src/parser.ts', lines: '1-25', snippet: 'export function parseRequest(req) { return req.body }', stage: 'explore', updatedAt: 7 })
  idx.upsert({ id: 'render', path: 'src/renderer.ts', lines: '3-30', snippet: 'class Renderer { render(node) { return node.text } }', stage: 'explore', updatedAt: 8 })
  const state = idx.exportState()
  assert.equal(state.version, 2)
  assert.equal(state.entries.length, 2)
  assert.ok(typeof state.entries[0].codes === 'string')
  const idx2 = createTurboQuantIndex({ dim: 512 })
  assert.equal(idx2.importState(state), true)
  assert.equal(idx2.stats().entries, 2)
  const h1 = idx.search('parseRequest body', { k: 1, minScore: 0.1 })
  const h2 = idx2.search('parseRequest body', { k: 1, minScore: 0.1 })
  assert.equal(h1[0].id, h2[0].id)
  assert.ok(Math.abs(h1[0].score - h2[0].score) < 1e-9)
})

test('TurboQuant maxEntries evicts the oldest snippet', () => {
  const idx = createTurboQuantIndex({ dim: 512, maxEntries: 2 })
  idx.upsert({ id: 'a', path: 'a.ts', lines: '1', snippet: 'aaa', updatedAt: 1 })
  idx.upsert({ id: 'b', path: 'b.ts', lines: '1', snippet: 'bbb', updatedAt: 2 })
  idx.upsert({ id: 'c', path: 'c.ts', lines: '1', snippet: 'ccc', updatedAt: 3 })
  assert.equal(idx.stats().entries, 2)
  const paths = idx.exportState().entries.map((e) => e.path).sort()
  assert.deepEqual(paths, ['b.ts', 'c.ts'])
})

test('TurboQuant upsert truncates free-text metadata', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  const big = 'x'.repeat(9000)
  const entry = idx.upsert({ id: 'a', path: 'a.ts', lines: '1', snippet: big, note: big })
  assert.equal(entry.snippet.length, 4000)
  assert.equal(entry.note.length, 1000)
  assert.equal(String(entry.lines).length, 1)
})

test('TurboQuant import skips corrupt entries and reports them', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 'good', path: 'good.ts', lines: '1-10', snippet: 'export function parseRequest(req) { return req.body }' })
  const state = idx.exportState()
  state.entries.push({ path: 'broken.ts', lines: '1', codes: '!!!!not-base64!!!!', norm: 1 })
  const idx2 = createTurboQuantIndex({ dim: 512 })
  assert.equal(idx2.importState(state), true)
  assert.equal(idx2.stats().entries, 1)
  assert.equal(idx2.stats().importSkipped, 1)
})

// ---- v0.8.1: digest cards, filters, deterministic sort, v2 import ----------

test('upsertDigest stores cards and caps per stage at 8', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  for (let i = 0; i < 10; i++) {
    idx.upsertDigest({ stage: 'implement', area: 'area-' + i, diffSummary: 'change ' + i, checks: 'pass' })
  }
  const st = idx.stats()
  assert.equal(st.digests, 8)
  assert.equal(st.snippets, 0)
  // oldest (area-0, area-1) were evicted, newest 8 kept
  const paths = idx.exportState().entries.filter((e) => e.kind === 'digest').map((e) => e.path).sort()
  assert.deepEqual(paths, ['area-2', 'area-3', 'area-4', 'area-5', 'area-6', 'area-7', 'area-8', 'area-9'])
})

test('upsertDigest refreshes an existing area+stage card', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsertDigest({ stage: 'fix', area: 'parser', diffSummary: 'first', updatedAt: 1 })
  const card = idx.upsertDigest({ stage: 'fix', area: 'parser', diffSummary: 'second', issues: 'edge case', updatedAt: 2 })
  assert.equal(idx.stats().digests, 1)
  assert.equal(card.snippet, 'second')
  assert.ok(card.note.includes('edge case'))
})

test('invalidateByPath never removes digest cards', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 's', path: 'src/parser.ts', lines: '1-10', snippet: 'export function parseRequest(req) { return req.body }' })
  idx.upsertDigest({ stage: 'implement', area: 'src/parser.ts', diffSummary: 'added validation' })
  // area string equals the snippet path on purpose (collision guard)
  const removed = idx.invalidateByPath('src/parser.ts')
  assert.equal(removed, 1)
  assert.equal(idx.stats().entries, 1)
  assert.equal(idx.stats().digests, 1)
  const hits = idx.search('added validation', { k: 5, minScore: 0.1, kindFilter: 'digest' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, 'digest')
})

test('search filters by kindFilter, stageFilter and array pathFilter', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 's1', path: 'src/a.ts', lines: '1', snippet: 'export function parseRequest(req) { return req.body }', stage: 'explore' })
  idx.upsert({ id: 's2', path: 'src/b.ts', lines: '1', snippet: 'export function parseRequest(req) { return req.body }', stage: 'explore' })
  idx.upsertDigest({ stage: 'implement', area: 'src/a.ts', diffSummary: 'implemented parseRequest with tests' })
  idx.upsertDigest({ stage: 'fix', area: 'src/c.ts', diffSummary: 'fixed parseRequest leak' })
  // kindFilter
  const d = idx.search('parseRequest implement', { k: 5, minScore: 0.05, kindFilter: 'digest' })
  assert.ok(d.length >= 1)
  assert.ok(d.every((h) => h.kind === 'digest'))
  // stageFilter
  const impl = idx.search('parseRequest', { k: 5, minScore: 0.05, kindFilter: 'digest', stageFilter: 'implement' })
  assert.ok(impl.every((h) => h.stage === 'implement'))
  // array pathFilter
  const inA = idx.search('parseRequest', { k: 10, minScore: 0.05, pathFilter: ['src/a.ts'] })
  assert.ok(inA.every((h) => h.path === 'src/a.ts' || h.path.startsWith('src/a.ts/')))
  const both = idx.search('parseRequest', { k: 10, minScore: 0.05, pathFilter: ['src/a.ts', 'src/b.ts'] })
  assert.ok(both.some((h) => h.path === 'src/a.ts'))
  assert.ok(both.some((h) => h.path === 'src/b.ts'))
})

test('search sorts deterministically on equal scores', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: '1', path: 'z.ts', lines: '1', snippet: 'export const x = 1' })
  idx.upsert({ id: '2', path: 'a.ts', lines: '1', snippet: 'export const x = 1' })
  const hits = idx.search('export const x = 1', { k: 5, minScore: 0.05 })
  assert.ok(hits.length >= 2)
  const order1 = hits.map((h) => h.path).join(',')
  const hits2 = idx.search('export const x = 1', { k: 5, minScore: 0.05 })
  assert.equal(order1, hits2.map((h) => h.path).join(','))
  assert.ok(hits[0].score >= hits[1].score)
})

test('import v1 and v2 both work; digests survive a v2 round-trip', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 's', path: 'src/a.ts', lines: '1', snippet: 'export function parseRequest(req) { return req.body }' })
  idx.upsertDigest({ stage: 'implement', area: 'src/a.ts', diffSummary: 'implemented with tests' })
  const state = idx.exportState()
  assert.equal(state.version, 2)
  // v1 compatibility: a legacy export carries snippets only, no kind field
  const v1 = {
    version: 1,
    dim: state.dim,
    maxEntries: state.maxEntries,
    entries: state.entries.filter((e) => e.kind !== 'digest').map(({ kind, ...rest }) => rest),
  }
  const idxV1 = createTurboQuantIndex({ dim: 512 })
  assert.equal(idxV1.importState(v1), true)
  assert.equal(idxV1.stats().snippets, 1)
  assert.equal(idxV1.stats().digests, 0)
  const idx2 = createTurboQuantIndex({ dim: 512 })
  assert.equal(idx2.importState(state), true)
  assert.equal(idx2.stats().digests, 1)
  const hits = idx2.search('implemented with tests', { k: 5, minScore: 0.05, kindFilter: 'digest' })
  assert.equal(hits.length, 1)
})

// ---- sidekick contracts ---------------------------------------------------

test('sidekick registry covers explore/implement/fix', () => {
  assert.deepEqual(SIDEKICK_STAGES, ['explore', 'implement', 'fix'])
  for (const stage of SIDEKICK_STAGES) {
    const spec = sidekickSpec(stage)
    assert.ok(spec, stage + ' spec exists')
    assert.equal(typeof spec.system, 'string')
    assert.equal(typeof spec.buildUser, 'function')
    assert.equal(typeof spec.parse, 'function')
  }
  assert.equal(sidekickSpec('nope'), undefined)
})

test('formatCard renders a card deterministically without timestamps', () => {
  const card = { stage: 'implement', path: 'src/parser.ts', snippet: 'added validation', note: 'npm test: pass\nno issues' }
  const t = formatCard(card)
  assert.ok(t.startsWith('• [implement/src/parser.ts] '), t)
  assert.ok(t.includes('added validation'))
  assert.ok(t.includes('npm test: pass'))
  assert.equal(t, formatCard(card))
})

test('sidekick buildUser has a byte-stable prefix per stage', () => {
  for (const stage of SIDEKICK_STAGES) {
    const a = sidekickSpec(stage).buildUser({ task: 'first task', paths: ['src'] })
    const b = sidekickSpec(stage).buildUser({ task: 'second task', paths: ['other'] })
    const cut = 'Task: '
    const ia = a.indexOf(cut)
    const ib = b.indexOf(cut)
    assert.ok(ia > 0 && ib > 0, stage + ' has a Task: line')
    assert.equal(a.slice(0, ia), b.slice(0, ib), stage + ' stable prefix')
    assert.ok(b.startsWith(a.slice(0, ia)), stage + ' prefix is a real prefix')
  }
})

test('sidekick buildUser appends cards and snippets after the stable prefix', () => {
  const user = sidekickSpec('implement').buildUser({
    task: 'write parser',
    cards: [formatCard({ stage: 'implement', path: 'src/parser.ts', snippet: 'added validation', note: 'pass' })],
    snippets: [{ path: 'src/parser.ts', lines: '1-25', snippet: 'export function parseRequest(req) {}' }],
  })
  assert.ok(user.includes('Previous outcomes (memory):'))
  assert.ok(user.includes('• [implement/src/parser.ts]'))
  assert.ok(user.includes('Known cached snippets'))
})

test('resolveSidekickTarget: stage override wins, else cheap tier', () => {
  const state = {
    tiers: { get: () => ({ provider: 'p-cheap', model: 'm-cheap', reasoningEffort: 'low' }) },
    sidekick: {
      explore: { provider: 'p-exp', model: 'm-exp', reasoningEffort: 'high' },
      implement: { provider: 'p-imp', model: 'm-imp' },
      fix: null,
    },
  }
  assert.deepEqual(resolveSidekickTarget('explore', state), { provider: 'p-exp', model: 'm-exp', reasoningEffort: 'high' })
  assert.deepEqual(resolveSidekickTarget('implement', state), { provider: 'p-imp', model: 'm-imp' })
  assert.deepEqual(resolveSidekickTarget('fix', state), { provider: 'p-cheap', model: 'm-cheap', reasoningEffort: 'low' })
  assert.equal(resolveSidekickTarget('explore', { sidekick: {}, tiers: null }), null)
})

test('parseExploreSnippets parses strict format, blocks, and JSON', () => {
  const strict = [
    'Snippet: src/parser.ts | 1-25 | export function parseRequest(req) { return req.body } | parses the request body',
    'Snippet: src/renderer.ts | 3-30 | class Renderer { render(node) { return node.text } } | renders a node',
  ].join('\n')
  const out = parseExploreSnippets(strict)
  assert.equal(out.length, 2)
  assert.equal(out[0].path, 'src/parser.ts')
  assert.equal(out[0].lines, '1-25')
  assert.ok(out[0].snippet.includes('parseRequest'))
  assert.equal(out[0].summary, 'parses the request body')

  const blocks = [
    '- File: src/a.ts',
    '  Lines: 10-20',
    '  Snippet: export const x = 1',
    '  Summary: defines x',
    '- File: src/b.ts',
    '  Snippet: import y from "./y"',
  ].join('\n')
  const b = parseExploreSnippets(blocks)
  assert.equal(b.length, 2)
  assert.equal(b[0].path, 'src/a.ts')
  assert.equal(b[0].lines, '10-20')
  assert.equal(b[1].path, 'src/b.ts')

  const json = JSON.stringify([
    { path: 'src/c.ts', lines: '1', snippet: '// c', summary: 'see' },
    { path: 'src/d.ts', lines: '2', snippet: '// d', summary: 'dee' },
  ])
  const j = parseExploreSnippets(json)
  assert.equal(j.length, 2)
  assert.equal(j[0].path, 'src/c.ts')
  assert.equal(parseExploreSnippets('no snippets here').length, 0)
})

test('parseChangeReport extracts touched files, summary and checks', () => {
  const text = [
    'Touched files:',
    '- src/parser.ts',
    '- tests/parser.test.ts',
    'Diff summary: added body validation and tests.',
    'Checks: npm test: pass; eslint: clean',
  ].join('\n')
  const r = parseChangeReport(text, true)
  assert.deepEqual(r.touchedFiles, ['src/parser.ts', 'tests/parser.test.ts'])
  assert.equal(r.diffSummary, 'added body validation and tests.')
  assert.ok(r.checks.includes('npm test'))

  const json = JSON.stringify({ touchedFiles: ['src/a.ts'], diffSummary: 'x', checks: 'pass' })
  const j = parseChangeReport(json, true)
  assert.deepEqual(j.touchedFiles, ['src/a.ts'])
  assert.equal(j.diffSummary, 'x')
})

// ---- advisor budget -------------------------------------------------------

test('decideAdvisorBudget allows under the limit', () => {
  assert.deepEqual(decideAdvisorBudget(0, 2, 30), { action: 'allow' })
  assert.deepEqual(decideAdvisorBudget(1, 2, 30), { action: 'allow' })
})

test('decideAdvisorBudget asks at the limit when confirmation is configured', () => {
  const d = decideAdvisorBudget(2, 2, 30)
  assert.equal(d.action, 'ask')
  assert.equal(d.timeoutMs, 30000)
})

test('decideAdvisorBudget denies when confirmation is disabled', () => {
  const d = decideAdvisorBudget(2, 2, 0)
  assert.equal(d.action, 'deny')
  assert.ok(d.reason.includes('limit (2)'))
})

// ---- childRouteSource: keepSeed / forceTier ------------------------------

test('childRouteSource: keepSeed preserves the seed verbatim', () => {
  assert.equal(childRouteSource({ keepSeed: true, escalated: false, pinned: false, explicit: true }), 'keep')
  assert.equal(childRouteSource({ keepSeed: true, escalated: false, pinned: false, explicit: false }), 'keep')
})

test('childRouteSource: escalation and pins outrank keepSeed', () => {
  assert.equal(childRouteSource({ keepSeed: true, escalated: true, pinned: false }), 'tier')
  assert.equal(childRouteSource({ keepSeed: true, escalated: false, pinned: true }), 'tier')
})

test('childRouteSource: forceTier skips the explicit-keep branch', () => {
  assert.equal(childRouteSource({ explicit: true, forceTier: true, escalated: false, pinned: false }), 'tier')
  assert.equal(childRouteSource({ explicit: true, forceTier: false, escalated: false, pinned: false }), 'keep')
  assert.equal(childRouteSource({ explicit: true, forceTier: undefined, escalated: false, pinned: false }), 'keep')
})

// ---- consultation soft parsing ---------------------------------------------

test('softParseSections parses JSON structured fields', () => {
  const json = JSON.stringify({ risks: ['a', 'b'], nextSteps: 'do x', acceptanceChecks: ['t1'] })
  const out = softParseSections(json, ['risks', 'nextSteps', 'acceptanceChecks'])
  assert.deepEqual(out.risks, ['a', 'b'])
  assert.deepEqual(out.nextSteps, ['do x'])
  assert.deepEqual(out.acceptanceChecks, ['t1'])
})

test('softParseSections parses Markdown sections', () => {
  const md = [
    '## Risks',
    '- auth tokens may leak',
    '- cache is unbounded',
    '## Next steps',
    '1. add TTL',
    '2. test',
    '## Acceptance criteria',
    '- all tests pass',
  ].join('\n')
  const out = softParseSections(md, ['risks', 'nextSteps', 'acceptanceChecks'])
  assert.equal(out.risks.length, 2)
  assert.ok(out.risks[0].includes('auth'))
  assert.equal(out.nextSteps.length, 2)
  assert.equal(out.acceptanceChecks.length, 1)
})

test('softParseSections tolerates plain text without sections', () => {
  const out = softParseSections('just advice, no sections', ['risks'])
  assert.equal(out.risks, undefined)
})

test('softParseSections edge cases: empty input, empty sections, partial JSON', () => {
  assert.deepEqual(softParseSections('', ['risks']), {})
  assert.deepEqual(softParseSections('   ', ['risks']), {})
  // section header with no items → the key is omitted (no empty arrays)
  const emptySection = '## Risks\n## Next steps\n- do x\n'
  const out = softParseSections(emptySection, ['risks', 'nextSteps'])
  assert.equal(out.risks, undefined)
  assert.deepEqual(out.nextSteps, ['do x'])
  // broken JSON falls through to the Markdown scan without throwing
  const broken = '{ "risks": [unclosed'
  const b = softParseSections(broken, ['risks'])
  assert.ok(b, 'never throws')
})
