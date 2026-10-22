// Sidekick contracts — pure data and parsing for the `smart` mode's
// explore/implement/fix stages. No harness imports, no I/O.
//
// The Main Agent keeps its context clean in smart mode: file edits go to a
// sidekick subagent spawned on a stage model. This module owns the stage
// registry (system prompts, user-prompt builders, response parsers) and the
// stage-route resolution.

export const SIDEKICK_STAGES = ['explore', 'implement', 'fix']

// The stage of a generic worker (tier_worker) outcome. Its digest cards are
// visible to the implement/fix stages (they carry the worker's experience),
// while the explore stage only sees its own cards.
export const WORKER_STAGE = 'worker'

/**
 * The digest stages one stage may read. 'explore' sees only its own cards;
 * every other stage also sees the worker experience.
 * @param stage - 'explore' | 'implement' | 'fix' | any other stage name.
 * @returns 'explore' or [stage, 'worker'].
 */
export function digestStagesFor(stage) {
  if (stage === 'explore') return 'explore'
  return [stage, WORKER_STAGE]
}

// Fixed per-stage preamble: byte-identical for every call of the stage, so
// the assembled prompt shares a stable prefix for provider-side prompt caches.
const STAGE_PREAMBLES = {
  explore: 'Code exploration for the Main Agent. Explore only; do not edit files. Report compact File snippets.',
  implement: 'Implementation for the Main Agent. Write focused code/tests/lint fixes, then run the relevant checks.',
  fix: 'Bug fix for the Main Agent. Diagnose, fix minimally, then run the relevant checks.',
}

/**
 * Pure formatting of one digest card for prompt assembly. No timestamps and
 * no insertion-order numbering, so identical cards render identically.
 * @param card - { stage, path (area), snippet (diffSummary), note (checks+issues) }.
 */
export function formatCard(card) {
  if (!card || typeof card !== 'object') return ''
  const stage = String(card.stage ?? '')
  const area = String(card.path ?? card.area ?? '')
  const summary = String(card.snippet ?? card.diffSummary ?? '')
  const note = String(card.note ?? '')
  const parts = []
  if (summary) parts.push(summary)
  if (note) parts.push(note)
  return '• [' + stage + '/' + area + '] ' + parts.join(' | ')
}

/**
 * The memory block of a prompt: the previous outcomes (digest cards) and the
 * known cached snippets. Returns plain prompt lines; the wording is
 * byte-identical to the private builder used by the sidekick prompts.
 * @param input - { snippets?: [{ path, lines, snippet }], cards?: string[] | card[],
 *   snippetsLabel?: string }.
 * @returns string[] — the prompt lines (empty when there is no memory).
 */
export function formatMemoryBlock(input = {}) {
  const lines = []
  const cards = Array.isArray(input.cards) ? input.cards : []
  if (cards.length > 0) {
    lines.push('Previous outcomes (memory):')
    for (const card of cards) {
      lines.push(typeof card === 'string' ? card : formatCard(card))
    }
  }
  const snippets = Array.isArray(input.snippets) ? input.snippets : []
  if (snippets.length > 0) {
    lines.push((input.snippetsLabel || 'Known cached snippets') + ' (do not re-grep unless needed):')
    for (const s of snippets.slice(0, 5)) {
      lines.push('- ' + (s.path || '?') + (s.lines ? ':' + s.lines : '') + ' ' + String(s.snippet || '').slice(0, 160))
    }
  }
  return lines
}

function buildSidekickUser(stage, input) {
  const parts = [STAGE_PREAMBLES[stage]]
  parts.push('Task: ' + String(input.task || '').trim())
  if (Array.isArray(input.paths) && input.paths.length > 0) {
    const label = stage === 'explore' ? 'Start from these files/dirs' : 'Relevant files'
    parts.push(label + ': ' + input.paths.join(', '))
  }
  const memory = formatMemoryBlock({ cards: input.cards, snippets: input.snippets })
  if (memory.length > 0) parts.push(memory.join('\n'))
  return parts.join('\n')
}

const EXPLORE_SYSTEM = [
  'You are a code-exploration sidekick for a main agent that plans and reviews.',
  'Explore the requested area and return ONLY a compact "File snippets" summary.',
  'Do not edit files. Do not paste whole files.',
  'For each relevant file, report: path, lines (range), a short snippet (a few lines), and a one-line summary.',
  'Format each entry as:',
  'Snippet: <path> | <lines> | <snippet> | <summary>',
  'Return nothing else.',
].join('\n')

const IMPLEMENT_SYSTEM = [
  'You are an implementation sidekick for a main agent that plans and reviews.',
  'Implement the requested change. Write code, write/update tests, fix lint.',
  'Work in the workspace. Make focused changes only; do not refactor unrelated code.',
  'After completing, run the relevant tests/linter and return ONLY:',
  'Touched files: <path> (one per line, starting with "-")',
  'Diff summary: <one short paragraph>',
  'Checks: <result of tests/lint, e.g. "npm test: pass">',
  'Return nothing else.',
].join('\n')

const FIX_SYSTEM = [
  'You are a bug-fix sidekick for a main agent that plans and reviews.',
  'Diagnose and fix the reported bug. Keep the change minimal.',
  'After fixing, run the relevant tests/linter and return ONLY:',
  'Touched files: <path> (one per line, starting with "-")',
  'Diff summary: <what was wrong and what changed>',
  'Checks: <result of tests/lint>',
  'Return nothing else.',
].join('\n')

const STAGE_SPECS = {
  explore: {
    stage: 'explore',
    title: 'Code exploration',
    system: EXPLORE_SYSTEM,
    buildUser(input) {
      return buildSidekickUser('explore', input)
    },
    parse(text, ok) {
      return { snippets: parseExploreSnippets(text), ok }
    },
  },
  implement: {
    stage: 'implement',
    title: 'Write code / Write tests / Fix lint',
    system: IMPLEMENT_SYSTEM,
    buildUser(input) {
      return buildSidekickUser('implement', input)
    },
    parse(text, ok) {
      return parseChangeReport(text, ok)
    },
  },
  fix: {
    stage: 'fix',
    title: 'Fix bugs',
    system: FIX_SYSTEM,
    buildUser(input) {
      return buildSidekickUser('fix', { ...input, task: 'Bug report: ' + String(input.task || '').trim() })
    },
    parse(text, ok) {
      return parseChangeReport(text, ok)
    },
  },
}

/** The stage spec, or undefined for an unknown stage. */
export function sidekickSpec(stage) {
  return STAGE_SPECS[stage]
}

/**
 * Resolve the model route for one sidekick stage.
 * @param stage - 'explore' | 'implement' | 'fix'.
 * @param state - { sidekick: { explore?, implement?, fix? }, tiers: tier registry }.
 *   Each stage entry is { provider, model, reasoningEffort? } or null; the
 *   base route is the cheap tier.
 * @returns { provider, model, reasoningEffort? } — the stage override when
 *   fully set, else the cheap tier route.
 */
export function resolveSidekickTarget(stage, state) {
  const over = state && state.sidekick && state.sidekick[stage]
  if (over && typeof over.provider === 'string' && over.provider.length > 0 &&
      typeof over.model === 'string' && over.model.length > 0) {
    return {
      provider: over.provider,
      model: over.model,
      ...(typeof over.reasoningEffort === 'string' && over.reasoningEffort.length > 0
        ? { reasoningEffort: over.reasoningEffort }
        : {}),
    }
  }
  const cheap = state && state.tiers ? state.tiers.get('cheap') : null
  if (cheap) {
    return {
      provider: cheap.provider,
      model: cheap.model,
      ...(typeof cheap.reasoningEffort === 'string' && cheap.reasoningEffort.length > 0
        ? { reasoningEffort: cheap.reasoningEffort }
        : {}),
    }
  }
  return null
}

// ---- parsing ---------------------------------------------------------------

/**
 * Parse an explore response into [{ path, lines, snippet, summary }].
 * Tolerates the strict "Snippet:" line format, "File:" blocks, JSON arrays,
 * and plain bullet lists.
 */
export function parseExploreSnippets(text) {
  const src = String(text || '')
  const out = []
  const seen = new Set()

  const push = (rec) => {
    if (!rec || typeof rec.path !== 'string' || rec.path.length === 0) return
    const key = rec.path + '::' + String(rec.lines || '')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path: rec.path, lines: rec.lines || '', snippet: rec.snippet || '', summary: rec.summary || '' })
  }

  // JSON first.
  const trimmed = src.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.snippets) ? parsed.snippets : [])
      for (const item of list) {
        if (item && typeof item === 'object') push(item)
      }
      if (out.length > 0) return out
    } catch (e) { /* fall through to text parsing */ }
  }

  // Strict "Snippet: path | lines | snippet | summary" lines.
  const strictRe = /^Snippet:\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*$/gim
  let m
  while ((m = strictRe.exec(src)) !== null) {
    push({ path: m[1].trim(), lines: m[2].trim(), snippet: m[3].trim(), summary: m[4].trim() })
  }
  if (out.length > 0) return out

  // "File: path" blocks with optional lines/snippet/summary lines.
  const blockRe = /(?:^|\n)\s*(?:-\s*)?(?:File|Path):\s*(.+?)\s*(?=\n\s*(?:-\s*)?(?:File|Path):|\s*$)/g
  const fileMarker = /(?:^|\n)\s*(?:-\s*)?(?:File|Path):\s*(.+?)\s*(?=\n|$)/g
  const fileSpans = []
  while ((m = fileMarker.exec(src)) !== null) fileSpans.push({ at: m.index, body: m[1].trim() })
  for (let i = 0; i < fileSpans.length; i++) {
    const start = fileSpans[i].at
    const end = i + 1 < fileSpans.length ? fileSpans[i + 1].at : src.length
    const block = src.slice(start, end)
    const rec = {}
    const pm = block.match(/(?:^|\n)\s*(?:-\s*)?(?:File|Path):\s*(.+?)\s*(?=\n|$)/i)
    if (pm) rec.path = pm[1].trim()
    const lm = block.match(/(?:^|\n)\s*(?:-\s*)?Lines?:\s*(.+?)\s*(?=\n|$)/i)
    if (lm) rec.lines = lm[1].trim()
    const sm = block.match(/(?:^|\n)\s*(?:-\s*)?Snippet:\s*(.+?)\s*(?=\n|$)/i)
    if (sm) rec.snippet = sm[1].trim()
    const um = block.match(/(?:^|\n)\s*(?:-\s*)?Summary:\s*(.+?)\s*(?=\n|$)/i)
    if (um) rec.summary = um[1].trim()
    push(rec)
  }
  if (out.length > 0) return out

  // Last resort: bare bullet lines "path | lines | snippet".
  for (const line of src.split('\n')) {
    const t = line.trim().replace(/^[-*]\s*/, '')
    if (!t || t.includes('Snippet:')) continue
    const parts = t.split('|')
    if (parts.length >= 3) {
      push({ path: parts[0].trim(), lines: parts[1].trim(), snippet: parts[2].trim(), summary: parts.length > 3 ? parts[3].trim() : '' })
    }
  }
  return out
}

/**
 * Parse an implement/fix response into { touchedFiles, diffSummary, checks }.
 * Tolerates "Touched files:" blocks, JSON, and free prose.
 */
export function parseChangeReport(text, ok) {
  const src = String(text || '')
  const out = { touchedFiles: [], diffSummary: '', checks: '', ok }

  const trimmed = src.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed.touchedFiles)) out.touchedFiles = parsed.touchedFiles.map(String)
      if (typeof parsed.diffSummary === 'string') out.diffSummary = parsed.diffSummary
      if (typeof parsed.checks === 'string') out.checks = parsed.checks
      return out
    } catch (e) { /* fall through */ }
  }

  const fileBlock = src.match(/(?:^|\n)\s*Touched files?:\s*(?:\n|$)([\s\S]*?)(?=\n\s*(?:Diff summary|Checks):|\s*$)/i)
  if (fileBlock) {
    const block = fileBlock[1]
    const listRe = /(?:^|\n)\s*[-*]\s*(.+?)\s*(?=\n|$)/g
    let m
    while ((m = listRe.exec(block)) !== null) {
      const f = m[1].trim()
      if (f) out.touchedFiles.push(f)
    }
    if (out.touchedFiles.length === 0) {
      for (const line of block.split('\n')) {
        const t = line.trim()
        if (t) out.touchedFiles.push(t)
      }
    }
  }

  const diff = src.match(/(?:^|\n)\s*Diff summary:\s*(.+?)\s*(?=\n\s*(?:Touched files|Checks):|\s*$)/i)
  if (diff) out.diffSummary = diff[1].trim()

  const checks = src.match(/(?:^|\n)\s*Checks?:\s*(.+?)\s*(?=\n\s*(?:Touched files|Diff summary):|\s*$)/i)
  if (checks) out.checks = checks[1].trim()

  // Fallback: parse any "- path" bullets anywhere (avoid matching diff text).
  if (out.touchedFiles.length === 0) {
    const anyList = /(?:^|\n)\s*[-*]\s*([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html|py|go|rs|java|c|cpp|h|hpp|md|yml|yaml|sh|bat|ps1|vue|svelte|sql))\s*(?=\n|$)/g
    let m
    while ((m = anyList.exec(src)) !== null) out.touchedFiles.push(m[1].trim())
  }

  return out
}
