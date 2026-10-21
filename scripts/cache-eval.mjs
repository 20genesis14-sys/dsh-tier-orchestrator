// Cache retrieval evaluation: index the repository with the same TurboQuant
// vectorizer the plugin uses, then run a fixed query set against it and
// report hit@1 / hit@3 plus the misses.
//
// This script is a pure measurement tool: it never throws, never touches the
// network and always exits 0 (a failed evaluation is a report, not a crash).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createTurboQuantIndex } from '../lib/core/turbovec.js'

const ROOT = process.cwd()
const MAX_FILES = 300
const MAX_LINES = 40
const TEXT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.css', '.html']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache'])

// [query, expected path]
const QUERIES = [
  ['sandbox policy write fence', 'lib/minimal-fs-tools.js'],
  ['worker delegation subagent', 'lib/index.js'],
  ['digest cards per stage quota', 'lib/core/turbovec.js'],
  ['prompt section pi mode', 'lib/core/prompt-section.js'],
  ['minimal fs tools read write edit', 'lib/minimal-fs-tools.js'],
  ['diagnostics counters', 'lib/core/metrics.js'],
  ['tier registry fallback chain', 'lib/core/tiers.js'],
  ['sidekick stage preambles', 'lib/core/sidekick.js'],
  ['reasoning effort ladder validate', 'lib/core/routing.js'],
  ['decision model client fetch', 'lib/dsh/decisions.js'],
  ['vector cache persistence debounce', 'lib/dsh/vec-cache.js'],
  ['guard high impact command detection', 'lib/core/guard.js'],
  ['subagent activation adapter', 'lib/dsh/subagents.js'],
  ['plugin installer patch preset rows', 'cordis.patch.yml'],
  ['web ui settings fields', 'client/client.js'],
]

function isTextFile(name) {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return TEXT_EXTENSIONS.includes(name.slice(dot).toLowerCase())
}

function toPosix(p) {
  return p.split(sep).join('/')
}

/** Walk the repo, collecting the relative paths of the text files. */
function collectFiles(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return out
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.dsh-')) continue
    if (!isTextFile(entry.name)) continue
    let st
    try {
      st = statSync(full)
    } catch (e) {
      continue
    }
    if (!st.isFile() || st.size > 1024 * 1024) continue
    out.push(toPosix(relative(ROOT, full)))
  }
  return out
}

function firstLines(path) {
  let text
  try {
    text = readFileSync(join(ROOT, path), 'utf8')
  } catch (e) {
    return ''
  }
  return text.split(/\r?\n/).slice(0, MAX_LINES).join('\n')
}

function main() {
  const files = collectFiles(ROOT, [])
  const index = createTurboQuantIndex()
  let entries = 0
  for (const path of files) {
    const snippet = firstLines(path)
    index.upsert({ id: path, path, lines: '1-' + MAX_LINES, snippet, note: '' })
    entries++
  }

  console.log('TurboQuant cache evaluation: ' + files.length + ' files, ' + entries + ' entries')
  let hit1 = 0
  let hit3 = 0
  let scoreSum = 0
  const misses = []
  for (const [query, expected] of QUERIES) {
    const results = index.search(query, { k: 3, minScore: -1 })
    const top = results.length > 0 ? results[0] : null
    const topPath = top ? top.path : '(none)'
    const topScore = top ? top.score : 0
    const rank = results.findIndex((r) => r.path === expected)
    const ok1 = rank === 0
    const ok3 = rank !== -1
    if (ok1) hit1++
    if (ok3) hit3++
    scoreSum += topScore
    if (!ok3) misses.push(query + ' -> ' + topPath)
    console.log((ok1 ? 'ok  ' : (ok3 ? 'ok3 ' : 'miss')) + '  ' + query + ' -> top: ' + topPath + ' (' + topScore.toFixed(3) + ')')
  }
  const mean = QUERIES.length > 0 ? scoreSum / QUERIES.length : 0
  console.log('summary: files=' + files.length + ' entries=' + entries + ' hit@1=' + hit1 + '/' + QUERIES.length + ' hit@3=' + hit3 + '/' + QUERIES.length + ' meanScore=' + mean.toFixed(3))
  if (misses.length > 0) {
    console.log('misses:')
    for (const m of misses) console.log('  ' + m)
  }
}

try {
  main()
} catch (e) {
  console.log('cache evaluation failed: ' + String(e && e.message || e))
}
process.exitCode = 0
