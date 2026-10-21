// Packaging / manifest integrity checks for dsh-tier-router.
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

test('package entry and exports are consistent', () => {
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  for (const f of pkg.files.concat([pkg.main])) {
    const p = join(ROOT, f)
    assert.ok(existsSync(p), 'missing packaged path: ' + f)
  }
  // Browser half: the Plugins-page settings card over the `tier-routing`
  // namespace (settings UI is NOT auto-generated in this Desktop build).
  assert.equal(pkg.exports['./client'], './client/client.js')
  assert.ok(pkg.files.includes('client'), 'client/ bundle is packaged')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const dep of [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ]) {
    assert.ok(pkg.dsh.client.inject.includes(dep), 'client inject misses ' + dep)
  }
  assert.ok(!pkg.files.includes('agent-presets'), 'no agent-presets/ bundle')
})

test('cordis.patch declares the host entry plus the tiered preset composition', () => {
  // Host-plane row: volatile config lives on the profile entry so SettingsForms
  // can render and persist it.
  assert.match(patch, /id:\s*tier-routing[\s\S]*?name:\s*dsh-tier-router/)
  // Agent-plane preset declaration.
  assert.match(patch, /id:\s*preset-tiered/)
  assert.match(patch, /name:\s*'@deepseek-ai\/dsh-agent-preset'/)
  assert.match(patch, /id:\s*tiered/)
  // The agent-plane router row inside the preset plugin list.
  assert.match(patch, /id:\s*tier-routing-agent/)
  assert.match(patch, /plane:\s*agent/)
  // Standard preset composition is present (spot-check critical plugins).
  for (const name of ['dsh-plan-mode', 'dsh-tool-subagent', 'dsh-tool-bash', 'dsh-tool-ask-user', 'dsh-workflow-ptc', 'dsh-compaction-basic', 'dsh-persona']) {
    assert.match(patch, new RegExp("name: '@deepseek-ai/" + name + "'"), 'preset misses ' + name)
  }
})

test('client bundle follows the ModuleLoader/slot contract', () => {
  const src = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')
  assert.match(src, /__ModuleLoader__\.load/)
  assert.match(src, /SETTINGS_NS\s*=\s*'tier-routing'/)
  assert.match(src, /configForms\.get\(SETTINGS_NS\)/)
  // The Plugins page renders a bundle's own configuration in
  // `plugins.bundle.config` and a row's page in `plugins.row.config`;
  // `plugins.item` is reserved for the shipped official settings pages.
  assert.match(src, /'plugins\.bundle\.config'/)
  assert.match(src, /'plugins\.row\.config'/)
  assert.match(src, /dsh-tier-router#/)
  assert.match(src, /'shell\.overlay'/)
  assert.match(src, /command\/executed/)
  assert.match(src, /remote\.session\.modelCatalog\(\)/)
  assert.ok(!/remote\.llm|llm\.listModels/.test(src), 'model lists come from the session catalog the picker uses')
  assert.match(src, /llm\/adapters-updated/)
  assert.match(src, /settings\/document-updated/)
  assert.ok(!/'plugins\.item'/.test(src), 'plugins.item belongs to the shipped official pages')
})

test('legacy packaging artifacts are gone', () => {
  assert.ok(!existsSync(join(ROOT, 'lib', 'preset-sync.js')))
  assert.ok(!existsSync(join(ROOT, 'agent-presets')))
})
