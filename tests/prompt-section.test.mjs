// Unit tests for the tier-routing prompt section builder (pure module).
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tierPromptSection } from '../lib/core/prompt-section.js'

const INFO = {
  promptMode: 'standard',
  mode: 'auto',
  threeTiers: false,
  planTier: 'strong',
  strongLabel: 'deepseek-official/deepseek-v4-pro (max)',
  mainLabel: 'deepseek-official/deepseek-v4-pro (high)',
  cheapLabel: 'deepseek-official/deepseek-v4-flash (low)',
  strongChain: 'deepseek-official/deepseek-v4-pro (max)',
  cheapChain: '(none)',
  subagentPolicy: 'inherit',
  fallbackTtlSec: 300,
  advisorMax: 2,
  advisorTimeoutSec: 30,
}

test('standard mode keeps the full guidance block', () => {
  const lines = tierPromptSection(INFO)
  assert.equal(lines[0], '## Tiered model routing')
  assert.ok(lines.join('\n').length > 1500)
  assert.ok(lines.some((l) => l.includes('tier_advisor')))
  assert.ok(lines.some((l) => l.includes('Never claim a tier or model ran')))
})

test('standard mode points searching or reading >=3 files at the explore sidekick', () => {
  const text = tierPromptSection(INFO).join('\n')
  assert.ok(text.includes('tier_sidekick'), text)
  assert.ok(text.includes('stage "explore"'), text)
  assert.ok(text.includes('>=3 files'), text)
  assert.ok(text.includes('3rd direct read/search call is blocked'), text)
})

test('pi mode collapses to a few short lines', () => {
  const lines = tierPromptSection({ ...INFO, promptMode: 'pi' })
  assert.equal(lines[0], '## Tiered model routing')
  const text = lines.join('\n')
  assert.ok(text.length < 500, 'pi section too long: ' + text.length)
  assert.ok(!text.includes('tier_advisor\n'))
  assert.ok(!text.includes('Never claim a tier or model ran'))
  assert.ok(text.includes('/tier status'))
})

test('pi mode tells the model to delegate missing-tool tasks via tier_worker', () => {
  const text = tierPromptSection({ ...INFO, promptMode: 'pi' }).join('\n')
  assert.ok(text.includes('tier_worker'))
  assert.ok(text.includes('agentPreset: tiered'))
})

test('pi mode still names tiers and mode', () => {
  const lines = tierPromptSection({ ...INFO, promptMode: 'pi' })
  const joined = lines.join('\n')
  assert.ok(joined.includes('deepseek-v4-pro'))
  assert.ok(joined.includes('deepseek-v4-flash'))
  assert.ok(joined.includes('auto'))
})
