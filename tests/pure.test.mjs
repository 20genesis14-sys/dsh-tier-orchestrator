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
