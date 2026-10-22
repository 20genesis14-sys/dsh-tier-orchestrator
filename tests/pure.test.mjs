// Unit tests for the pure core logic of dsh-tier-orchestrator (no harness required).
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHighImpact, hasRecursiveForceRm } from '../lib/core/guard.js'
import { resolveTierSpec, classifyFallback, validateReasoningEffort, nextEffortStep, fallbackActive, advanceFallback, migrateTierConfig, reconcileReasoningEffort, EFFORT_LADDER, DEFAULT_TIER_CONFIG, FALLBACK_TRIGGER_CODES, FALLBACK_IGNORE_CODES, attemptChain } from '../lib/core/routing.js'
import { escalationStep, escalationActive, escalationExpired, decideGuardAction, decideErrorActions, decidePlanExit, EXPLORE_TOOLS, SMART_MAIN_READ_BUDGET, decideSmartReadBudget } from '../lib/core/policy.js'
import { consultSpec, CONSULTS, modelFamily, reviewerConflicts } from '../lib/core/consult.js'
import { childRouteSource, cappedTier } from '../lib/core/routing.js'
import { createTierRegistry, tierLabel, chainText, TIER_ORDER } from '../lib/core/tiers.js'
import { embedCodeText, rotateVector, createTurboQuantIndex, TURBO_LEVELS, DIGEST_MAX_PER_STAGE } from '../lib/core/turbovec.js'
import { sidekickSpec, resolveSidekickTarget, resolveSidekickFallbackTarget, parseExploreSnippets, parseChangeReport, formatCard, formatMemoryBlock, digestStagesFor, WORKER_STAGE, SIDEKICK_STAGES } from '../lib/core/sidekick.js'
import { decideAdvisorBudget } from '../lib/core/policy.js'
import {
  noulQuestion, choiceQuestion, scoreQuestion, buildGuardQuestions, buildTierQuestion,
  buildEscalationQuestion, buildConsultQuestion, buildDecisionState, parseDecisionAnswers,
  decideByThresholds, decisionKey, isDecisionStageEnabled, DECISION_STAGES,
} from '../lib/core/decision.js'
import { softParseSections } from '../lib/core/consult.js'
import { pickCacheUsage, analyzeCacheLapses, formatCacheLapseReport, DEFAULT_CACHE_TTL_MS, DEFAULT_SHARE_THRESHOLD, DEFAULT_LAPSES_PER_HOUR_THRESHOLD, DEFAULT_MIN_LAPSES_FOR_VERDICT } from '../lib/core/cache-cost.js'

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
  const legacy = migrateTierConfig('strong', { provider: 'x', model: 'y', reasoningEffort: 'high' })
  assert.deepEqual(legacy.fallback, [{ provider: 'x', model: 'y', reasoningEffort: 'high' }], 'legacy config mirrors primary as the fallback')
  const explicit = migrateTierConfig('cheap', { provider: 'x', model: 'y', reasoningEffort: 'low', fallback: [] })
  assert.deepEqual(explicit.fallback, [], 'empty array is a real chain, not legacy')
})

test('defaults: strong is deepseek-v4-pro at max, cheap is deepseek-v4-flash at low effort', () => {
  assert.equal(DEFAULT_TIER_CONFIG.strong.model, 'deepseek-v4-pro')
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

test('reconcileReasoningEffort prefers the model default, then the nearest declared level', () => {
  const defaulted = { efforts: [{ id: 'high' }, { id: 'max' }], defaultEffort: 'max' }
  assert.equal(reconcileReasoningEffort('medium', defaulted).effort, 'max')
  const noDefault = { efforts: [{ id: 'high' }, { id: 'max' }] }
  assert.equal(reconcileReasoningEffort('medium', noDefault).effort, 'high')
  assert.equal(reconcileReasoningEffort('low', { efforts: [] }).effort, 'low', 'lenient without ids')
})

test('an undeclared effort falls to the nearest declared level, never to the floor', () => {
  const capped = { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }
  assert.equal(reconcileReasoningEffort('max', capped).effort, 'high', 'a max request keeps the model ceiling')
  assert.equal(reconcileReasoningEffort('high', capped).effort, 'high')
  assert.equal(reconcileReasoningEffort('medium', capped).effort, 'medium')
  const offFirst = { efforts: [{ id: 'off' }, { id: 'high' }] }
  // Not 'off': disabling reasoning is not a downgrade level. minimax m3.1
  // flash free (off|high|max) answers a disabled reasoning with 400, so a
  // positive request upgrades to the lowest positive level instead.
  const offFirstFit = reconcileReasoningEffort('low', offFirst)
  assert.equal(offFirstFit.effort, 'high', 'never downgrade a positive effort to off')
  assert.match(offFirstFit.reason, /using "high"/, 'the substitution is reported')
  assert.equal(reconcileReasoningEffort('off', capped).effort, 'low', 'below every declared level: the floor')
  assert.equal(reconcileReasoningEffort('minimal', { efforts: [{ id: 'high' }, { id: 'max' }] }).effort, 'high', 'an unknown id never invents a level')
})

test('reconcileReasoningEffort never disables reasoning for a positive request (minimax m3.1 flash free)', () => {
  // Exact declared shape reported live: the model offers off|high|max while
  // the cheap tier asks for 'low'. Picking 'off' made the endpoint answer
  // 400 "Reasoning is mandatory for this endpoint and cannot be disabled".
  const minimax = { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] }
  assert.equal(reconcileReasoningEffort('low', minimax).effort, 'high', 'a request below every positive level upgrades to the lowest one')
  assert.equal(reconcileReasoningEffort('medium', minimax).effort, 'high', 'the nearest declared level at or below the request')
  const max = reconcileReasoningEffort('max', minimax)
  assert.equal(max.effort, 'max', 'a declared level is kept verbatim')
  assert.equal(max.reason, null)
  assert.equal(reconcileReasoningEffort('off', minimax).effort, 'off', 'an explicit off is still honoured')
})

test('reconcileReasoningEffort never turns an omitted effort into off', () => {
  // A tier or sidekick stage configured without an explicit effort passes
  // `undefined`: dsh-llm then leaves the choice to the adapter (or applies its
  // own default). Fitting that onto the ladder's floor picked "off", and
  // minimax m3.1 flash free rejects a disabled reasoning with 400
  // "Reasoning is mandatory for this endpoint and cannot be disabled".
  const minimax = { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] }
  assert.deepEqual(reconcileReasoningEffort(undefined, minimax), { effort: undefined, reason: null })
  assert.deepEqual(reconcileReasoningEffort(null, minimax), { effort: undefined, reason: null })
  assert.deepEqual(reconcileReasoningEffort('', minimax), { effort: undefined, reason: null })
  assert.deepEqual(
    reconcileReasoningEffort(undefined, { efforts: [{ id: 'high' }, { id: 'max' }] }),
    { effort: undefined, reason: null },
    'an omitted effort is not upgraded to a positive level either',
  )
  assert.deepEqual(
    reconcileReasoningEffort(undefined, { efforts: [], defaultEffort: 'high' }),
    { effort: undefined, reason: null },
    'the declared model default is left to the adapter',
  )
  assert.equal(reconcileReasoningEffort('off', minimax).effort, 'off', 'an explicit off is still a disable request')
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

test('main defaults to deepseek-v4-pro at high effort', () => {
  assert.equal(DEFAULT_TIER_CONFIG.main.model, 'deepseek-v4-pro')
  assert.equal(DEFAULT_TIER_CONFIG.main.followSession, undefined)
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
  assert.equal(snap.strong.followSession, undefined)
  assert.equal(snap.strong.model, 'deepseek-v4-pro')
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

test('upsertDigest stores cards below the per-stage cap', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  for (let i = 0; i < 10; i++) {
    idx.upsertDigest({ stage: 'implement', area: 'area-' + i, diffSummary: 'change ' + i, checks: 'pass' })
  }
  const st = idx.stats()
  assert.equal(st.digests, 10, 'ten cards are below the cap')
  assert.equal(st.snippets, 0)
})

test('the per-stage digest cap keeps DIGEST_MAX_PER_STAGE cards and evicts the oldest', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  const cap = DIGEST_MAX_PER_STAGE
  for (let i = 0; i < cap + 1; i++) {
    idx.upsertDigest({ stage: 'implement', area: 'area-' + i, diffSummary: 'change ' + i, checks: 'pass', updatedAt: i + 1 })
  }
  const st = idx.stats()
  assert.equal(st.digests, cap, 'the cap is DIGEST_MAX_PER_STAGE cards per stage')
  const paths = idx.exportState().entries.filter((e) => e.kind === 'digest').map((e) => e.path).sort()
  assert.equal(paths.length, cap)
  assert.ok(paths.includes('area-' + cap), 'the newest card is kept')
  assert.ok(!paths.includes('area-0'), 'the oldest card was evicted')
  assert.ok(paths.includes('area-1'))
  // Another stage keeps its own quota.
  idx.upsertDigest({ stage: 'worker', area: 'w-1', diffSummary: 'worker change', updatedAt: 100 })
  assert.equal(idx.stats().digests, cap + 1)
  assert.equal(idx.stats().stages.implement, cap)
  assert.equal(idx.stats().stages.worker, 1)
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

test('search accepts an array stageFilter', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsertDigest({ stage: 'implement', area: 'src/a.ts', diffSummary: 'implemented parseRequest with tests' })
  idx.upsertDigest({ stage: 'fix', area: 'src/c.ts', diffSummary: 'fixed parseRequest leak' })
  idx.upsertDigest({ stage: 'worker', area: 'src/w.ts', diffSummary: 'worker changed parseRequest' })
  const both = idx.search('parseRequest', { k: 5, minScore: 0.05, kindFilter: 'digest', stageFilter: ['implement', 'worker'] })
  assert.ok(both.length >= 2, 'both stages match: ' + both.length)
  assert.ok(both.every((h) => h.stage === 'implement' || h.stage === 'worker'))
  const one = idx.search('parseRequest', { k: 5, minScore: 0.05, kindFilter: 'digest', stageFilter: ['fix'] })
  assert.ok(one.length >= 1)
  assert.ok(one.every((h) => h.stage === 'fix'))
  const single = idx.search('parseRequest', { k: 5, minScore: 0.05, kindFilter: 'digest', stageFilter: 'implement' })
  assert.ok(single.every((h) => h.stage === 'implement'))
  const none = idx.search('parseRequest', { k: 5, minScore: 0.05, kindFilter: 'digest', stageFilter: ['explore'] })
  assert.equal(none.length, 0)
})

test('stats().stages counts the digest cards per stage', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsertDigest({ stage: 'implement', area: 'a', diffSummary: 'one' })
  idx.upsertDigest({ stage: 'implement', area: 'b', diffSummary: 'two' })
  idx.upsertDigest({ stage: 'worker', area: 'c', diffSummary: 'three' })
  idx.upsert({ id: 's', path: 'src/a.ts', lines: '1', snippet: 'export const x = 1', stage: 'explore' })
  const st = idx.stats()
  assert.deepEqual(st.stages, { explore: 0, implement: 2, fix: 0, worker: 1 })
  assert.equal(st.snippets, 1)
  assert.equal(st.digests, 3)
})

test('list returns plain entries sorted by path, lines and stage', () => {
  const idx = createTurboQuantIndex({ dim: 512 })
  idx.upsert({ id: 's2', path: 'src/b.ts', lines: '10-20', snippet: 'export const b = 1', stage: 'explore', updatedAt: 2 })
  idx.upsert({ id: 's1', path: 'src/b.ts', lines: '1-5', snippet: 'export const a = 1', stage: 'explore', updatedAt: 1 })
  idx.upsertDigest({ stage: 'implement', area: 'src/a.ts', diffSummary: 'implemented', updatedAt: 3 })
  const all = idx.list()
  assert.deepEqual(all.map((e) => e.path + ':' + e.lines), ['src/a.ts:', 'src/b.ts:1-5', 'src/b.ts:10-20'])
  assert.deepEqual(all.map((e) => e.kind), ['digest', 'snippet', 'snippet'])
  assert.ok(!('codes' in all[0]), 'list never exposes the quantized codes')
  assert.equal(all[0].stage, 'implement')
  const digests = idx.list({ kind: 'digest' })
  assert.equal(digests.length, 1)
  const workers = idx.list({ stage: 'worker' })
  assert.equal(workers.length, 0)
  const many = idx.list({ stage: ['implement', 'explore'] })
  assert.equal(many.length, 3)
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

test('sidekick buildUser puts the response contract before the task', () => {
  const explore = sidekickSpec('explore').buildUser({ task: 'x' })
  const snippetAt = explore.indexOf('Snippet: <path>')
  const exploreTaskAt = explore.indexOf('Task: x')
  assert.ok(snippetAt > 0, 'explore names the snippet contract: ' + explore)
  assert.ok(exploreTaskAt > snippetAt, 'the snippet contract is part of the stable prefix, before the task')

  for (const stage of ['implement', 'fix']) {
    const user = sidekickSpec(stage).buildUser({ task: 'x' })
    const taskAt = user.indexOf('Task: ')
    assert.ok(taskAt > 0, stage + ' has a Task: line')
    const touchedAt = user.indexOf('Touched files:')
    const diffAt = user.indexOf('Diff summary:')
    assert.ok(touchedAt >= 0 && touchedAt < taskAt, stage + ' contract lists the touched files before the task')
    assert.ok(diffAt >= 0 && diffAt < taskAt, stage + ' contract asks for the diff summary before the task')
  }
  // implement embeds the task verbatim; fix labels it as a bug report, but
  // both keep the contract above the variable part.
  assert.ok(sidekickSpec('implement').buildUser({ task: 'x' }).includes('Task: x'))
  assert.ok(sidekickSpec('fix').buildUser({ task: 'x' }).includes('Task: Bug report: x'))
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

test('digestStagesFor: explore sees only explore, the other stages see the worker', () => {
  assert.equal(WORKER_STAGE, 'worker')
  assert.equal(digestStagesFor('explore'), 'explore')
  assert.deepEqual(digestStagesFor('implement'), ['implement', 'worker'])
  assert.deepEqual(digestStagesFor('fix'), ['fix', 'worker'])
})

test('formatMemoryBlock renders the cards and snippets like the sidekick prompt', () => {
  const card = formatCard({ stage: 'implement', path: 'src/parser.ts', snippet: 'added validation', note: 'pass' })
  const lines = formatMemoryBlock({
    cards: [card],
    snippets: [{ path: 'src/parser.ts', lines: '1-25', snippet: 'export function parseRequest(req) {}' }],
  })
  assert.deepEqual(lines, [
    'Previous outcomes (memory):',
    card,
    'Known cached snippets (do not re-grep unless needed):',
    '- src/parser.ts:1-25 export function parseRequest(req) {}',
  ])
  const custom = formatMemoryBlock({ snippets: [{ path: 'a.ts', snippet: 'x' }], snippetsLabel: 'Relevant snippets' })
  assert.deepEqual(custom, ['Relevant snippets (do not re-grep unless needed):', '- a.ts x'])
  assert.deepEqual(formatMemoryBlock({}), [])
  // the same wording as the sidekick prompt builder
  const user = sidekickSpec('implement').buildUser({ task: 't', cards: [card], snippets: [{ path: 'src/parser.ts', lines: '1-25', snippet: 'export function parseRequest(req) {}' }] })
  assert.ok(user.includes(lines.join('\n')), user)
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

test('resolveSidekickFallbackTarget skips the primary route and walks implement -> fix -> main -> strong', () => {
  const primary = { provider: 'p-cheap', model: 'm-cheap' }
  const stateWith = (implement, fix, main, strong) => ({
    tiers: { get: (name) => ({ main, strong })[name] || null },
    sidekick: { explore: null, implement, fix },
  })

  // The configured implement route is the first distinct candidate.
  assert.deepEqual(
    resolveSidekickFallbackTarget('explore', stateWith({ provider: 'p-imp', model: 'm-imp', reasoningEffort: 'high' }, null, null, null), primary),
    { provider: 'p-imp', model: 'm-imp', reasoningEffort: 'high' },
  )

  // A candidate matching the primary provider/model pair is skipped (effort ignored).
  assert.deepEqual(
    resolveSidekickFallbackTarget('explore', stateWith({ provider: 'p-cheap', model: 'm-cheap', reasoningEffort: 'max' }, { provider: 'p-fix', model: 'm-fix' }, null, null), primary),
    { provider: 'p-fix', model: 'm-fix' },
  )

  // Unusable stage entries (missing model) fall through to the main tier.
  assert.deepEqual(
    resolveSidekickFallbackTarget('explore', stateWith(primary, { provider: 'p-cheap' }, { provider: 'p-main', model: 'm-main' }, { provider: 'p-strong', model: 'm-strong' }), primary),
    { provider: 'p-main', model: 'm-main' },
  )

  // Only the strong tier is left distinct.
  assert.deepEqual(
    resolveSidekickFallbackTarget('explore', stateWith(primary, primary, null, { provider: 'p-strong', model: 'm-strong' }), primary),
    { provider: 'p-strong', model: 'm-strong' },
  )

  // No distinct candidate at all.
  assert.equal(resolveSidekickFallbackTarget('explore', stateWith(primary, null, null, null), primary), null)
  assert.equal(resolveSidekickFallbackTarget('explore', { sidekick: {}, tiers: null }, primary), null)
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

test('parseChangeReport tolerates heading, bold and Russian section labels', () => {
  // A markdown heading with no colon, a bold label with one, and a localized
  // label: models produce all three spellings of the same section.
  const heading = [
    '## Changed files',
    'src/a.ts, src/b.ts',
    'Diff summary: patched both modules.',
    'Checks: npm test: pass',
  ].join('\n')
  const h = parseChangeReport(heading, true)
  assert.deepEqual(h.touchedFiles, ['src/a.ts', 'src/b.ts'])
  assert.equal(h.diffSummary, 'patched both modules.')
  assert.ok(h.checks.includes('npm test'))

  const bold = [
    '**Touched files:**',
    '- `lib/x.js`',
    '**Diff summary:** tightened the parser.',
    '**Checks:** eslint: clean',
  ].join('\n')
  const b = parseChangeReport(bold, true)
  assert.deepEqual(b.touchedFiles, ['lib/x.js'])
  assert.equal(b.diffSummary, 'tightened the parser.')
  assert.ok(b.checks.includes('eslint'))

  const russian = [
    'Изменённые файлы:',
    '- src/ru.ts',
    'Diff summary: переписан парсер.',
  ].join('\n')
  const ru = parseChangeReport(russian, true)
  assert.deepEqual(ru.touchedFiles, ['src/ru.ts'])
  assert.equal(ru.diffSummary, 'переписан парсер.')
})

test('parseChangeReport strips markdown links, angle brackets and line anchors', () => {
  const r = parseChangeReport('- [smoke.test.mjs](<tests/smoke.test.mjs#L10-L20>)', true)
  assert.deepEqual(r.touchedFiles, ['tests/smoke.test.mjs'])
})

test('parseChangeReport reads backticked Windows and POSIX paths in prose', () => {
  const win = 'D:\\dsh-tier-router\\tmp-smart-probe\\created.md'
  const text = 'Updated `' + win + '` and `lib/core/sidekick.js:42`.'
  const r = parseChangeReport(text, true)
  assert.deepEqual(r.touchedFiles, [win, 'lib/core/sidekick.js'])
  assert.ok(r.diffSummary.startsWith('Updated'), r.diffSummary)
})

test('parseChangeReport reads a fenced JSON block, including a same-line body', () => {
  for (const fenced of [
    '```json { "touchedFiles": ["src/a.ts"], "diffSummary": "json fence", "checks": "ok" } ```',
    '```json\n{ "touchedFiles": ["src/a.ts"], "diffSummary": "json fence", "checks": "ok" }\n```',
  ]) {
    const r = parseChangeReport(fenced, true)
    assert.deepEqual(r.touchedFiles, ['src/a.ts'], fenced)
    assert.equal(r.diffSummary, 'json fence', fenced)
    assert.equal(r.checks, 'ok', fenced)
  }
})

test('parseChangeReport falls back to the first prose line for a missing summary', () => {
  const text = [
    'Touched files:',
    '- src/x.ts',
    'updated the parser to validate the request body',
  ].join('\n')
  const r = parseChangeReport(text, true)
  assert.deepEqual(r.touchedFiles, ['src/x.ts'])
  assert.equal(r.diffSummary, 'updated the parser to validate the request body')
})

test('parseChangeReport keeps a plain worker-ok response free of phantom files', () => {
  assert.deepEqual(parseChangeReport('worker-ok', true), { touchedFiles: [], diffSummary: '', checks: '', ok: true })
})

test('parseExploreSnippets extracts a linked File block and described bullet', () => {
  const block = [
    '- File: [sidekick.js](<lib/core/sidekick.js#L10-L25>)',
    '  Snippet: export function parseChangeReport(text, ok) {}',
    '  Summary: parses change reports',
  ].join('\n')
  const b = parseExploreSnippets(block)
  assert.equal(b.length, 1)
  assert.equal(b[0].path, 'lib/core/sidekick.js')
  assert.equal(b[0].lines, '10-25')
  assert.ok(b[0].snippet.includes('parseChangeReport'))
  assert.equal(b[0].summary, 'parses change reports')

  const bullet = '- [sidekick.js](<lib/core/sidekick.js#L10-L25>) — parses reports'
  const u = parseExploreSnippets(bullet)
  assert.equal(u.length, 1)
  assert.equal(u[0].path, 'lib/core/sidekick.js')
  assert.equal(u[0].lines, '10-25')
  assert.equal(u[0].summary, 'parses reports')
  assert.equal(u[0].snippet, 'parses reports')
})

test('EXPLORE_TOOLS includes ops_read_files and the gate reason names the delegation path', () => {
  assert.ok(EXPLORE_TOOLS.includes('ops_read_files'))
  assert.ok(EXPLORE_TOOLS.includes('read'))
  const denied = decidePlanExit({ planActive: true, explored: 0, minExplore: 2, advisorGate: true, consulted: false })
  assert.equal(denied.action, 'deny')
  assert.ok(denied.reason.includes('ops_read_files'), denied.reason)
  assert.ok(denied.reason.includes('tier_sidekick'), denied.reason)
  assert.equal(decidePlanExit({ planActive: true, explored: 2, minExplore: 2, advisorGate: false, consulted: false }).action, 'allow')
})

// ---- smart-mode read budget ------------------------------------------------

test('SMART_MAIN_READ_BUDGET allows two direct read/search calls and denies the third', () => {
  assert.equal(SMART_MAIN_READ_BUDGET, 2)
  assert.deepEqual(decideSmartReadBudget(0, 'read', {}), { action: 'allow', nextReads: 1 })
  assert.deepEqual(decideSmartReadBudget(1, 'grep', {}), { action: 'allow', nextReads: 2 })
  for (const name of ['glob', 'read', 'ops_read_files']) {
    const args = name === 'ops_read_files' ? { files: [{ path: 'a' }] } : {}
    const denied = decideSmartReadBudget(2, name, args)
    assert.equal(denied.action, 'deny', name + ' is denied on the third call')
    assert.equal(denied.nextReads, 2, name + ' leaves the counter unchanged')
    assert.match(denied.reason, />=3 files/, denied.reason)
    assert.match(denied.reason, /tier_sidekick/, denied.reason)
    assert.match(denied.reason, /stage "explore"/, denied.reason)
  }
})

test('decideSmartReadBudget charges an ops_read_files batch its file count', () => {
  const three = decideSmartReadBudget(0, 'ops_read_files', { files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] })
  assert.equal(three.action, 'deny', 'one >=3-file batch is denied immediately')
  assert.equal(three.nextReads, 0)
  assert.match(three.reason, />=3 files/)

  const twoAtOne = decideSmartReadBudget(1, 'ops_read_files', { files: [{ path: 'a' }, { path: 'b' }] })
  assert.equal(twoAtOne.action, 'deny', '1 used + 2 files exceeds the budget of 2')
  assert.equal(twoAtOne.nextReads, 1)

  assert.deepEqual(decideSmartReadBudget(1, 'ops_read_files', { files: [{ path: 'a' }] }), { action: 'allow', nextReads: 2 })
})

test('decideSmartReadBudget ignores tools outside the explore set', () => {
  assert.deepEqual(decideSmartReadBudget(0, 'tier_status', {}), { action: 'allow', nextReads: 0 })
  assert.deepEqual(decideSmartReadBudget(2, 'tier_status', {}), { action: 'allow', nextReads: 2 })
  assert.deepEqual(decideSmartReadBudget(2, 'write', {}), { action: 'allow', nextReads: 2 })
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

// ---- decision-model primitives (Jev / System One / OpenRouter Decisions) ----

test('question builders emit the expected wire shapes', () => {
  const n = noulQuestion('is it safe?')
  assert.equal(n.type, 'noul')
  assert.equal(n.instructions, 'is it safe?')
  const c = choiceQuestion('pick one', { cheap: 'cheap tier', strong: 'strong tier' })
  assert.equal(c.type, 'choice')
  assert.deepEqual(c.criteria, { cheap: 'cheap tier', strong: 'strong tier' })
  const s = scoreQuestion('rate x')
  assert.equal(s.type, 'score')
})

test('buildGuardQuestions drops serves_task without task and within_project without project', () => {
  const full = buildGuardQuestions({ commands: ['rm -rf x'], project: '/work', task: 'clean up' })
  assert.ok(full.reversible)
  assert.ok(full.within_project)
  assert.ok(full.serves_task)
  const noTask = buildGuardQuestions({ commands: ['rm -rf x'], project: '/work' })
  assert.ok(noTask.reversible)
  assert.ok(noTask.within_project)
  assert.equal(noTask.serves_task, undefined)
  const bare = buildGuardQuestions({ commands: ['rm -rf x'] })
  assert.ok(bare.reversible)
  assert.equal(bare.within_project, undefined)
  assert.equal(bare.serves_task, undefined)
})

test('parseDecisionAnswers accepts a valid noul answer and returns probabilities', () => {
  const questions = { reversible: noulQuestion('reversible?') }
  const res = parseDecisionAnswers({ answers: { reversible: { type: 'noul', noul: 0.95 } } }, questions)
  assert.equal(res.ok, true)
  assert.equal(res.values.reversible, 0.95)
  assert.equal(res.probabilities.reversible, 0.95)
})

test('parseDecisionAnswers is strict: missing/malformed answers are errors, never zeros', () => {
  const questions = { a: noulQuestion('a?'), b: noulQuestion('b?') }
  assert.equal(parseDecisionAnswers({ answers: { a: { type: 'noul', noul: 0.9 } } }, questions).ok, false)
  assert.equal(parseDecisionAnswers({ answers: { a: { type: 'noul', noul: 0.9 }, b: { type: 'noul', noul: 1.5 } } }, questions).ok, false)
  assert.equal(parseDecisionAnswers({ answers: { a: { type: 'noul', noul: -0.1 }, b: { type: 'noul', noul: 0.5 } } }, questions).ok, false)
  assert.equal(parseDecisionAnswers(null, questions).ok, false)
  assert.equal(parseDecisionAnswers('not json', questions).ok, false)
  assert.equal(parseDecisionAnswers({}, questions).ok, false)
})

test('parseDecisionAnswers validates choice criteria and confidence', () => {
  const questions = { tier: choiceQuestion('which?', { cheap: 'c', strong: 's' }) }
  const ok = parseDecisionAnswers({ answers: { tier: { type: 'choice', choice: 'strong', confidence: 0.8 } } }, questions)
  assert.equal(ok.ok, true)
  assert.equal(ok.values.tier, 'strong')
  assert.equal(ok.probabilities.tier, 0.8)
  const unknown = parseDecisionAnswers({ answers: { tier: { type: 'choice', choice: 'main' } } }, questions)
  assert.equal(unknown.ok, false)
})

test('a choice answer without confidence is read from its probability map', () => {
  const questions = { tier: choiceQuestion('which?', { cheap: 'c', strong: 's' }) }
  const chosen = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'strong', probabilities: { cheap: 0.16, strong: 0.84 } } },
  }, questions)
  assert.equal(chosen.ok, true)
  assert.equal(chosen.values.tier, 'strong')
  assert.equal(chosen.probabilities.tier, 0.84, 'the probability of the chosen option counts')
  const other = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'strong', probabilities: { cheap: 0.2, strong: 0.6 } } },
  }, questions)
  assert.equal(other.probabilities.tier, 0.6)
  const missing = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'strong' } },
  }, questions)
  assert.equal(missing.ok, true)
  assert.equal(missing.probabilities.tier, undefined, 'no probability, no approval')
  const broken = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'strong', probabilities: { cheap: 'x', strong: null } } },
  }, questions)
  assert.equal(broken.probabilities.tier, undefined, 'an invalid map is ignored, not trusted')
})

test('a choice answer never borrows the probability of another option', () => {
  const questions = { tier: choiceQuestion('which?', { cheap: 'c', strong: 's' }) }
  const out = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'strong', probabilities: { cheap: 0.99 } } },
  }, questions)
  assert.equal(out.ok, true)
  assert.equal(out.probabilities.tier, undefined, 'the chosen option has no probability: no approval')
  const inherited = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'constructor', probabilities: {} } },
  }, { tier: { type: 'choice', instructions: 'which?' } })
  assert.equal(inherited.ok, true)
  assert.equal(inherited.probabilities.tier, undefined, 'a prototype key is not a probability')
  const coerced = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'strong', confidence: '0.99' } },
  }, questions)
  assert.equal(coerced.probabilities.tier, undefined, 'a string is not a probability')
  const outOfRange = parseDecisionAnswers({
    answers: { tier: { type: 'choice', choice: 'strong', confidence: 2 } },
  }, questions)
  assert.equal(outOfRange.probabilities.tier, undefined)
})

test('a score answer falls back to its confidence', () => {
  const questions = { urgency: scoreQuestion('how urgent?') }
  const out = parseDecisionAnswers({ answers: { urgency: { type: 'score', confidence: 0.9 } } }, questions)
  assert.equal(out.ok, true)
  assert.equal(out.values.urgency, 0.9)
  assert.equal(out.probabilities.urgency, 0.9)
  const scored = parseDecisionAnswers({ answers: { urgency: { type: 'score', score: 3 } } }, questions)
  assert.equal(scored.values.urgency, 3)
  assert.equal(scored.probabilities.urgency, undefined, 'a raw score is not a probability')
  const broken = parseDecisionAnswers({ answers: { urgency: { type: 'score' } } }, questions)
  assert.equal(broken.ok, false)
})

test('decideByThresholds maps probabilities to approve/block/review/unknown', () => {
  assert.equal(decideByThresholds({ a: 0.95, b: 0.99 }), 'approve')
  assert.equal(decideByThresholds({ a: 0.05 }), 'block')
  assert.equal(decideByThresholds({ a: 0.7 }), 'review')
  assert.equal(decideByThresholds({}), 'unknown')
  assert.equal(decideByThresholds(null), 'unknown')
  assert.equal(decideByThresholds({ a: NaN }), 'unknown')
})

test('decisionKey is stable across object key orders', () => {
  const a = decisionKey({ tier: 'cheap', task: 'x', commands: ['a', 'b'] })
  const b = decisionKey({ commands: ['a', 'b'], task: 'x', tier: 'cheap' })
  assert.equal(a, b)
  assert.notEqual(a, decisionKey({ tier: 'cheap', task: 'x', commands: ['a'] }))
})

test('isDecisionStageEnabled respects the configured stage list', () => {
  assert.equal(isDecisionStageEnabled(['guard', 'escalate'], 'guard'), true)
  assert.equal(isDecisionStageEnabled(['guard'], 'worker'), false)
  assert.equal(isDecisionStageEnabled(undefined, 'guard'), false)
  assert.deepEqual(DECISION_STAGES, ['guard', 'escalate', 'worker', 'consult'])
})

// ---- smart mode child routing ---------------------------------------------

test('smart mode: the main agent plans, children execute on the weak tier', () => {
  const tiers = ['strong', 'cheap']
  // Main agent: the caller pins it to the plan tier itself; the pure spec only
  // says a non-child has no smart routing decision.
  assert.equal(resolveTierSpec({ mode: 'smart', isChild: false, planActive: true, tiers }), null)
  // A child under an inherited policy is execution work: weak tier, even in
  // plan mode.
  assert.equal(resolveTierSpec({ mode: 'smart', isChild: true, subagentPolicy: 'inherit', planActive: true, tiers }), 'cheap')
  assert.equal(resolveTierSpec({ sessionMode: 'smart', isChild: true, subagentPolicy: 'inherit', planActive: false, tiers }), 'cheap')
  // An explicit per-kind policy still outranks the smart default.
  assert.equal(resolveTierSpec({ mode: 'smart', isChild: true, subagentPolicy: 'strong', planActive: true, tiers }), 'strong')
  // Three tiers: the weak tier is cheap, not main.
  assert.equal(resolveTierSpec({ mode: 'smart', isChild: true, subagentPolicy: 'inherit', planActive: true, tiers: ['strong', 'main', 'cheap'] }), 'cheap')
})

test('escalation and explicit pins still outrank the smart child default', () => {
  const tiers = ['strong', 'cheap']
  assert.equal(resolveTierSpec({ mode: 'smart', isChild: true, escalated: true, subagentPolicy: 'inherit', tiers }), 'strong')
  assert.equal(resolveTierSpec({ mode: 'smart', isChild: true, explicitTier: 'cheap', subagentPolicy: 'inherit', tiers }), 'cheap')
})

test('a pin or session mode of an inactive tier keeps the seed instead of downgrading', () => {
  const two = ['strong', 'cheap']
  const three = ['strong', 'main', 'cheap']
  assert.equal(resolveTierSpec({ explicitTier: 'main', mode: 'auto', tiers: two }), null, 'main is not active: no decision')
  assert.equal(resolveTierSpec({ sessionMode: 'main', mode: 'auto', tiers: two }), null)
  assert.equal(resolveTierSpec({ explicitTier: 'main', mode: 'auto', tiers: three }), 'main')
  assert.equal(resolveTierSpec({ sessionMode: 'main', mode: 'auto', tiers: three }), 'main')
  // A mode keyword is not a tier name and must keep working.
  assert.equal(resolveTierSpec({ sessionMode: 'auto', mode: 'auto', planActive: false, tiers: two }), 'cheap')
  assert.equal(resolveTierSpec({ sessionMode: 'off', mode: 'auto', tiers: two }), null)
})

// ---- cache-lapse telemetry (smart-mode prefix cache) ---------------------

// One main-agent step whose prompt prefix is 1600 tokens (100 fresh + 1000
// cache read + 500 cache write) and a 500-token cache write.
const LAPSE_USAGE = { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 500, outputTokens: 50 }
const LAPSE_STEPS = [{ ts: 0 }, { ts: 400_000, usage: LAPSE_USAGE }]
const LAPSE_WINDOW = [{ start: 10_000, end: 300_000 }]
const LAPSE_TARIFFS = { prompt: 4, cacheRead: 0.2, cacheWrite: 5, completion: 20 }

test('cache telemetry: defaults match the documented thresholds', () => {
  assert.equal(DEFAULT_CACHE_TTL_MS, 300_000)
  assert.equal(DEFAULT_SHARE_THRESHOLD, 0.05)
  assert.equal(DEFAULT_LAPSES_PER_HOUR_THRESHOLD, 2)
  assert.equal(DEFAULT_MIN_LAPSES_FOR_VERDICT, 3)
})

test('cache telemetry: no steps is insufficient data, never a crash', () => {
  const analysis = analyzeCacheLapses([], [])
  assert.equal(analysis.keptSteps, 0)
  assert.equal(analysis.lapseCount, 0)
  assert.equal(analysis.attributableLapseCount, 0)
  assert.equal(analysis.lapsesPerHour, null)
  assert.equal(analysis.verdict, 'insufficient-data')
  assert.equal(analysis.recommendLongRetention, false)
  assert.equal(analysis.estimatedRewriteCostUsd, null)
  assert.deepEqual(analysis.lapses, [])
  const lines = formatCacheLapseReport(analysis)
  assert.ok(Array.isArray(lines))
  assert.ok(lines.length > 0)
  assert.ok(lines.every(function (line) { return typeof line === 'string' }))
  assert.deepEqual(formatCacheLapseReport(null), ['cache telemetry: no data'])
})

test('cache telemetry: a gap past the ttl is a lapse, a child window makes it attributable', () => {
  const analysis = analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW)
  assert.equal(analysis.keptSteps, 2)
  assert.equal(analysis.childWindowCount, 1)
  assert.equal(analysis.lapseCount, 1)
  assert.equal(analysis.attributableLapseCount, 1)
  assert.equal(analysis.estimatedRewriteTokens, 1600)
  assert.equal(analysis.actualRewriteTokens, 500)
  const lapse = analysis.lapses[0]
  assert.equal(lapse.gapStartTs, 0)
  assert.equal(lapse.gapEndTs, 400_000)
  assert.equal(lapse.gapMs, 400_000)
  assert.equal(lapse.overlapMs, 290_000)
  assert.equal(lapse.attributable, true)
  assert.equal(lapse.prefixTokens, 1600, 'the prefix is the SECOND step\'s input side')
})

test('cache telemetry: a lapse outside every child window is not attributable', () => {
  const analysis = analyzeCacheLapses(LAPSE_STEPS, [])
  assert.equal(analysis.lapseCount, 1)
  assert.equal(analysis.attributableLapseCount, 0)
  assert.equal(analysis.recommendLongRetention, false)
  assert.equal(analysis.lapses[0].attributable, false)
  assert.equal(analysis.lapses[0].overlapMs, 0)
})

test('cache telemetry: a gap inside the ttl is not a lapse', () => {
  const analysis = analyzeCacheLapses([{ ts: 0 }, { ts: 100_000, usage: LAPSE_USAGE }], LAPSE_WINDOW)
  assert.equal(analysis.lapseCount, 0)
  assert.equal(analysis.attributableLapseCount, 0)
  assert.equal(analysis.estimatedRewriteTokens, 0)
})

test('cache telemetry: unsorted steps analyze exactly like sorted ones', () => {
  const sorted = [{ ts: 0 }, { ts: 400_000, usage: LAPSE_USAGE }]
  const unsorted = [{ ts: 400_000, usage: LAPSE_USAGE }, { ts: 0 }]
  const snapshot = JSON.stringify(unsorted)
  const a = analyzeCacheLapses(sorted, LAPSE_WINDOW)
  const b = analyzeCacheLapses(unsorted, LAPSE_WINDOW)
  assert.deepEqual(b, a)
  assert.equal(JSON.stringify(unsorted), snapshot, 'inputs are copied, never reordered in place')
  // Unusable timestamps are dropped and counted, not fatal.
  const mixed = analyzeCacheLapses([{ ts: 0 }, { ts: Number.NaN }, { ts: 'x' }, { ts: 400_000, usage: LAPSE_USAGE }], LAPSE_WINDOW)
  assert.equal(mixed.skippedSteps, 2)
  assert.equal(mixed.keptSteps, 2)
  assert.equal(mixed.lapseCount, 1)
})

test('cache telemetry: tariffs price the re-write and its share of the session', () => {
  const analysis = analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW, { tariffs: LAPSE_TARIFFS })
  assert.equal(analysis.tariffsApplied, true)
  assert.equal(analysis.estimatedRewriteCostUsd, 1600 * 5 / 1e6)
  assert.equal(analysis.actualRewriteCostUsd, 500 * 5 / 1e6)
  assert.ok(analysis.estimatedSessionCostUsd > 0)
  assert.equal(analysis.lapseShare, analysis.estimatedRewriteCostUsd / analysis.estimatedSessionCostUsd)
  // A partial tariff block is unusable: no USD, token share instead.
  const partial = analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW, { tariffs: { prompt: 4, cacheRead: 0.2, cacheWrite: 5 } })
  assert.equal(partial.tariffsApplied, false)
  assert.equal(partial.estimatedRewriteCostUsd, null)
  assert.equal(partial.actualRewriteCostUsd, null)
  assert.equal(partial.estimatedSessionCostUsd, null)
  assert.equal(partial.lapseShare, 1600 / partial.totalInputSideTokens)
  assert.equal(partial.totalInputSideTokens, 1600)
  // The priced report says dollars; the unpriced one does not.
  assert.ok(formatCacheLapseReport(analysis).some(function (line) { return line.indexOf('~$') !== -1 }))
  assert.ok(formatCacheLapseReport(partial).every(function (line) { return line.indexOf('~$') === -1 }))
})

test('cache telemetry: the verdict compares the lapse share against the threshold', () => {
  const material = analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW, { tariffs: LAPSE_TARIFFS, minLapsesForVerdict: 2 })
  assert.equal(material.verdict, 'material')
  const big = [{ ts: 0, usage: { inputTokens: 10_000_000 } }, { ts: 400_000, usage: LAPSE_USAGE }]
  const negligible = analyzeCacheLapses(big, LAPSE_WINDOW, { tariffs: LAPSE_TARIFFS, minLapsesForVerdict: 2 })
  assert.equal(negligible.verdict, 'negligible')
  // A real lapse on too few observed steps stays insufficient data.
  const thin = analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW, { tariffs: LAPSE_TARIFFS })
  assert.equal(thin.lapseCount, 1)
  assert.equal(thin.verdict, 'insufficient-data')
  const strict = analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW, { tariffs: LAPSE_TARIFFS, minLapsesForVerdict: 2, shareThreshold: 0 })
  assert.equal(strict.verdict, 'material')
})

test('cache telemetry: long retention is recommended from attributable lapses per hour', () => {
  const base = 1_767_225_600_000
  const steps = [0, 1_200_000, 2_400_000, 3_600_000].map(function (offset) {
    return { ts: base + offset, usage: LAPSE_USAGE }
  })
  const hot = analyzeCacheLapses(steps, [{ start: base, end: base + 3_600_000 }])
  assert.equal(hot.lapseCount, 3)
  assert.equal(hot.attributableLapseCount, 3)
  assert.equal(hot.lapsesPerHour, 3)
  assert.equal(hot.recommendLongRetention, true)
  // One attributable lapse is below the default evidence bar.
  const cold = analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW)
  assert.equal(cold.attributableLapseCount, 1)
  assert.equal(cold.recommendLongRetention, false)
  // No elapsed span means no rate, and therefore no recommendation.
  const flat = analyzeCacheLapses([{ ts: 5, usage: LAPSE_USAGE }, { ts: 5, usage: LAPSE_USAGE }], [])
  assert.equal(flat.lapsesPerHour, null)
  assert.equal(flat.recommendLongRetention, false)
})

test('pickCacheUsage normalizes adapter token usage', () => {
  assert.equal(pickCacheUsage(null), null)
  assert.equal(pickCacheUsage(undefined), null)
  assert.deepEqual(pickCacheUsage({}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.deepEqual(
    pickCacheUsage({ inputTokens: -5, cacheReadTokens: 'x', cacheWriteTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
  assert.deepEqual(
    pickCacheUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 9999, reasoningTokens: 7 }),
    { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
  )
})

test('cache telemetry: the report only hints at long retention when the evidence supports it', () => {
  const base = 1_767_225_600_000
  const steps = [0, 1_200_000, 2_400_000, 3_600_000].map(function (offset) {
    return { ts: base + offset, usage: LAPSE_USAGE }
  })
  const hot = formatCacheLapseReport(analyzeCacheLapses(steps, [{ start: base, end: base + 3_600_000 }]), { usageFields: 'reported' })
  assert.ok(hot.some(function (line) { return line.indexOf('long') !== -1 }), 'a hint mentions long retention')
  const cold = formatCacheLapseReport(analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW))
  assert.ok(cold.every(function (line) { return line.indexOf('long') === -1 }), 'no hint without evidence')
  // The TTL is rendered in whole minutes.
  const ttl = formatCacheLapseReport(analyzeCacheLapses(LAPSE_STEPS, LAPSE_WINDOW, { ttlMs: 600_000 }), { ttlMs: 600_000 })
  assert.ok(ttl.some(function (line) { return line.indexOf('10 min') !== -1 }))
})