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

// The per-stage system contract. It is part of the *user* prompt (the system
// prompt is assembled by the harness), and it is byte-identical for every call
// of the same stage, so it extends the stable cache prefix. It must therefore
// be defined before the prompt builder below.
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

const STAGE_SYSTEMS = {
  explore: EXPLORE_SYSTEM,
  implement: IMPLEMENT_SYSTEM,
  fix: FIX_SYSTEM,
}

function buildSidekickUser(stage, input) {
  // Preamble + system contract form the byte-stable prefix; everything that
  // varies (task, paths, memory) is appended after 'Task: '.
  const parts = [STAGE_PREAMBLES[stage], STAGE_SYSTEMS[stage]]
  parts.push('Task: ' + String(input.task || '').trim())
  if (Array.isArray(input.paths) && input.paths.length > 0) {
    const label = stage === 'explore' ? 'Start from these files/dirs' : 'Relevant files'
    parts.push(label + ': ' + input.paths.join(', '))
  }
  const memory = formatMemoryBlock({ cards: input.cards, snippets: input.snippets })
  if (memory.length > 0) parts.push(memory.join('\n'))
  return parts.join('\n')
}

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
  const over = pickRoute(state && state.sidekick && state.sidekick[stage])
  if (over) return over
  return pickRoute(state && state.tiers ? state.tiers.get('cheap') : null)
}

/**
 * Normalize one { provider, model, reasoningEffort? } entry to a route, or
 * null when it is not a usable route (missing provider/model; the cheap tier
 * of an unconfigured registry is such a case).
 */
function pickRoute(entry) {
  if (!entry || typeof entry.provider !== 'string' || entry.provider.length === 0) return null
  if (typeof entry.model !== 'string' || entry.model.length === 0) return null
  return {
    provider: entry.provider,
    model: entry.model,
    ...(typeof entry.reasoningEffort === 'string' && entry.reasoningEffort.length > 0
      ? { reasoningEffort: entry.reasoningEffort }
      : {}),
  }
}

/** Whether two routes point at the same provider/model (effort ignored). */
function sameRoute(a, b) {
  if (!a || !b) return false
  return a.provider === b.provider && a.model === b.model
}

/**
 * Resolve a backup route for a sidekick stage when the primary route fails
 * or returns empty output (or when explore has no explicit override but
 * implement/fix has a configured working route).
 * Preference order: sidekick.implement -> sidekick.fix -> tiers.get('main') -> tiers.get('strong').
 * Returns a route distinct from `primaryRoute`, or null if none exists.
 */
export function resolveSidekickFallbackTarget(stage, state, primaryRoute) {
  const primary = pickRoute(primaryRoute)
  const candidates = [
    state && state.sidekick && state.sidekick.implement,
    state && state.sidekick && state.sidekick.fix,
    state && state.tiers ? state.tiers.get('main') : null,
    state && state.tiers ? state.tiers.get('strong') : null,
  ]
  for (const candidate of candidates) {
    const route = pickRoute(candidate)
    if (!route) continue
    if (sameRoute(route, primary)) continue
    return route
  }
  return null
}

// ---- parsing ---------------------------------------------------------------

// File extensions a report may legitimately mention. Anything else is prose.
const FILE_EXT_PATTERN = 'ts|tsx|js|jsx|mjs|cjs|json|css|html|py|go|rs|java|c|cpp|h|hpp|md|yml|yaml|sh|bat|ps1|vue|svelte|sql|toml|lock|txt'

const FILE_EXT_RE = new RegExp('\\.(?:' + FILE_EXT_PATTERN + ')$', 'i')

// A candidate path inside free text: path characters ending in a known
// extension. The engine starts leftmost, so `lib/a.js — x` yields `lib/a.js`.
const FILE_TOKEN_RE = new RegExp('[\\w./\\\\@~:-]*?\\.(?:' + FILE_EXT_PATTERN + ')(?![\\w])', 'gi')

const MD_LINK_RE = /\[[^\]]*\]\(\s*<?([^)<>]+?)>?\s*\)/g
// The same shape without `g`: `.match(global)` would drop the capture group.
const MD_LINK_ONE_RE = /\[[^\]]*\]\(\s*<?([^)<>]+?)>?\s*\)/
const BACKTICK_RE = /`([^`]+)`/g
const BACKTICK_ONE_RE = /`([^`]+)`/

// A list bullet ("- x", "* x", "• x", "1. x") at the start of a line.
const BULLET_RE = /^(?:[-*•]|\d+[.)])\s+/

// Optional markdown decoration in front of a section label: "## ", "**".
const SECTION_HEAD = '(?:#{1,6}\\s*|\\*{1,2})?'

const TOUCHED_LABELS =
  '(?:Touched\\s+files?|Changed\\s+files?|Modified\\s+files?|Updated\\s+files?|Created\\s+files?' +
  '|Files?\\s+(?:touched|changed|modified|updated)' +
  '|Измен[её]нные\\s+файлы|Затронутые\\s+файлы)'

// "Touched files:" (or a paraphrase, optionally under a heading / bold label).
const TOUCHED_HEAD_RE = new RegExp(
  // The colon is optional: a markdown heading ("## Changed files") and a bold
  // label ("**Touched files:**") are both section headers.
  '(?:^|\\n)[ \\t]*' + SECTION_HEAD + TOUCHED_LABELS + '\\*{0,2}[ \\t]*:?\\*{0,2}[ \\t]*' +
  '([\\s\\S]*?)' +
  '(?=\\n[ \\t]*' + SECTION_HEAD + '(?:Diff\\s+summary|Summary|Changes|Checks?|Tests?|Validation|Проверка|Тесты)\\*{0,2}[ \\t]*:' +
  '|\\n[ \\t]*#{1,6}[ \\t]+' +
  '|$)',
  'i'
)

// A single line that is a section label rather than prose.
const SECTION_LINE_RE = new RegExp(
  '^' + SECTION_HEAD +
  '(?:Touched\\s+files?|Changed\\s+files?|Modified\\s+files?|Updated\\s+files?|Created\\s+files?' +
  '|Files?\\s+(?:touched|changed|modified|updated)' +
  '|Diff\\s+summary|Summary|Changes|Checks?|Tests?|Validation' +
  '|Измен[её]нные\\s+файлы|Затронутые\\s+файлы|Проверка|Тесты)' +
  '\\*{0,2}[ \\t]*:',
  'i'
)

/**
 * Normalize one path token taken from a free-form LLM report.
 *
 * Handles markdown links `[label](<target>)`, wrapping backticks / quotes /
 * bold / list bullets, a trailing human description (" — text", " - text",
 * " (text)", ": text"), `#L10-L20` and `:10-20` line anchors, and rejects
 * URLs as well as tokens that do not end in a known file extension.
 *
 * @param raw - the raw token (any type; non-strings become '').
 * @returns the normalized relative/absolute path, or '' when it is not one.
 */
export function cleanPathToken(raw) {
  let t = String(raw == null ? '' : raw).trim()
  if (!t) return ''

  // `[label](<target>)` / `[label](target)` → target.
  const link = t.match(MD_LINK_ONE_RE)
  if (link) t = link[1].trim()

  // Peel wrappers and the trailing description; repeat because a link target
  // may itself be wrapped (`` `[a](b.js)` ``) and the description may follow
  // the closing backtick.
  for (let pass = 0; pass < 3; pass++) {
    const before = t
    t = t.replace(/^[`"'«»\s]+/, '').replace(/[`"'«»\s]+$/, '')
    t = t.replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '')
    t = t.replace(/^[•·]\s*/, '')
    t = t.replace(/^[([{<]+/, '').replace(/[)\]}>]+$/, '')
    t = t.replace(BULLET_RE, '')
    t = t.replace(/\s+[—–]\s+[\s\S]*$/, '')
    t = t.replace(/\s+-\s+[\s\S]*$/, '')
    t = t.replace(/\s+\([\s\S]*$/, '')
    t = t.replace(/\s*:\s+[\s\S]*$/, '')
    t = t.replace(/#[Ll]\d+(?:[-–][Ll]?\d+)?$/, '')
    t = t.replace(/[.,;:]+$/, '')
    if (t === before) break
  }

  // A colon past the drive-letter position starts an anchor or a description:
  // `lib/index.js:24-30` → `lib/index.js`, while `C:\dir\a.md` keeps its colon
  // (index 1) and is not mistaken for an anchor.
  const colonAt = t.indexOf(':')
  if (colonAt > 1) t = t.slice(0, colonAt).trim().replace(/[.,;:]+$/, '')

  if (!t || /\s/.test(t)) return ''
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(t)) return '' // http://, file://, //
  if (!FILE_EXT_RE.test(t)) return ''
  return t
}

/**
 * Every file path mentioned in one free-form text chunk, in first-seen order.
 * Markdown links win; otherwise backticked spans; otherwise bare file tokens.
 */
function extractPathsFromText(text) {
  const src = String(text == null ? '' : text)
  const found = []
  const add = (v) => {
    const p = cleanPathToken(v)
    if (p && found.indexOf(p) === -1) found.push(p)
  }
  let m
  MD_LINK_RE.lastIndex = 0
  while ((m = MD_LINK_RE.exec(src)) !== null) add(m[1])
  if (found.length > 0) return found
  BACKTICK_RE.lastIndex = 0
  while ((m = BACKTICK_RE.exec(src)) !== null) add(m[1])
  if (found.length > 0) return found
  FILE_TOKEN_RE.lastIndex = 0
  while ((m = FILE_TOKEN_RE.exec(src)) !== null) add(m[0])
  return found
}

/** Paths of one "Touched files" block: inline comma lists and bullet lines. */
function collectBlockPaths(block) {
  const found = []
  for (const rawLine of String(block || '').split('\n')) {
    let line = rawLine.trim()
    if (!line) continue
    line = line.replace(BULLET_RE, '').trim()
    if (!line) continue
    for (const item of line.split(/\s*[,;]\s*/)) {
      if (!item) continue
      for (const path of extractPathsFromText(item)) {
        if (found.indexOf(path) === -1) found.push(path)
      }
    }
  }
  return found
}

/**
 * Split a "path-ish" token (link, backticked or plain) into its path and an
 * optional line range carried as `#L10-L20` / `:10-20`.
 * @returns { path, lines } — lines is '' when the token had no anchor.
 */
function stripPathDecor(raw) {
  let t = String(raw == null ? '' : raw).trim()
  let lines = ''
  if (!t) return { path: '', lines: '' }
  const link = t.match(MD_LINK_ONE_RE)
  if (link) t = link[1].trim()
  t = t.replace(/^[`"'«»\s]+/, '').replace(/[`"'«»\s]+$/, '')
  t = t.replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '')

  const anchor = t.match(/#[Ll](\d+(?:[-–][Ll]?\d+)?)$/)
  if (anchor) {
    lines = anchor[1].replace(/[Ll]/g, '').replace(/[–]/g, '-')
    t = t.slice(0, anchor.index)
  } else {
    const colonAt = t.lastIndexOf(':')
    if (colonAt > 1) {
      const tail = t.slice(colonAt + 1)
      if (/^\d+(?:[-–]\d+)?$/.test(tail)) {
        lines = tail.replace(/[–]/g, '-')
        t = t.slice(0, colonAt)
      }
    }
  }
  return { path: t.trim().replace(/^[([{<]+/, '').replace(/[)\]}>]+$/, ''), lines }
}

/**
 * Parse an explore response into [{ path, lines, snippet, summary }].
 * Tolerates the strict "Snippet:" line format, "File:" blocks, JSON arrays,
 * markdown links / backticked bullet lists, and plain bullet lists.
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

  // Strict "Snippet: path | lines | snippet | summary" lines. The path may be a
  // markdown link or backticked, and may carry the line range itself.
  const strictRe = /^Snippet:\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*$/gim
  let m
  while ((m = strictRe.exec(src)) !== null) {
    const decor = stripPathDecor(m[1])
    push({ path: decor.path, lines: m[2].trim() || decor.lines, snippet: m[3].trim(), summary: m[4].trim() })
  }
  if (out.length > 0) return out

  // "File: path" blocks with optional lines/snippet/summary lines.
  const fileMarker = /(?:^|\n)\s*(?:-\s*)?(?:File|Path):\s*(.+?)\s*(?=\n|$)/g
  const fileSpans = []
  while ((m = fileMarker.exec(src)) !== null) fileSpans.push({ at: m.index, body: m[1].trim() })
  for (let i = 0; i < fileSpans.length; i++) {
    const start = fileSpans[i].at
    const end = i + 1 < fileSpans.length ? fileSpans[i + 1].at : src.length
    const block = src.slice(start, end)
    const rec = {}
    const pm = block.match(/(?:^|\n)\s*(?:-\s*)?(?:File|Path):\s*(.+?)\s*(?=\n|$)/i)
    if (pm) {
      const decor = stripPathDecor(pm[1])
      rec.path = decor.path
      if (decor.lines) rec.lines = decor.lines
    }
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
    const t = line.trim().replace(/^[-*•]\s*/, '')
    if (!t || t.includes('Snippet:')) continue
    const parts = t.split('|')
    if (parts.length >= 3) {
      push({ path: parts[0].trim(), lines: parts[1].trim(), snippet: parts[2].trim(), summary: parts.length > 3 ? parts[3].trim() : '' })
    }
  }
  if (out.length > 0) return out

  // Last resort: bullet lines that point at a linked or backticked file and
  // describe it, e.g. "- `lib/core/sidekick.js` — parses sidekick output".
  for (const line of src.split('\n')) {
    const raw = line.trim()
    if (!BULLET_RE.test(raw)) continue
    const body = raw.replace(BULLET_RE, '').trim()
    if (!body) continue
    const link = body.match(MD_LINK_ONE_RE)
    const tick = link ? null : body.match(BACKTICK_ONE_RE)
    if (!link && !tick) continue
    const span = link ? link[0] : tick[0]
    const decor = stripPathDecor(link ? link[1] : tick[1])
    if (!decor.path || !FILE_EXT_RE.test(decor.path)) continue
    const desc = body.replace(span, '').replace(/^[\s:—–\-|]+/, '').trim()
    push({ path: decor.path, lines: decor.lines, snippet: desc, summary: desc })
  }
  return out
}

/**
 * Parse an implement/fix response into { touchedFiles, diffSummary, checks }.
 * Tolerates JSON (bare or fenced), "Touched files:" blocks with markdown /
 * backticked / bulleted paths, "Diff summary:" and "Checks:" labels, and free
 * prose that merely mentions the files it changed.
 */
export function parseChangeReport(text, ok) {
  const src = String(text || '')
  const out = { touchedFiles: [], diffSummary: '', checks: '', ok }

  const addFile = (value) => {
    const path = cleanPathToken(value)
    if (!path) return
    if (out.touchedFiles.indexOf(path) === -1) out.touchedFiles.push(path)
  }

  // 1. A pure JSON answer.
  const trimmed = src.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed.touchedFiles)) parsed.touchedFiles.map(String).forEach(addFile)
      if (typeof parsed.diffSummary === 'string') out.diffSummary = parsed.diffSummary
      if (typeof parsed.checks === 'string') out.checks = parsed.checks
      return out
    } catch (e) { /* fall through to the text parsers */ }
  }

  // 2. A fenced ```json block carrying the same object shape.
  // A fenced block may start its JSON on the same line as the fence info
  // string (```json {...} ```) or on the following line, as models write both.
  const fenceRe = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi
  let m
  while ((m = fenceRe.exec(src)) !== null) {
    const body = m[1].trim()
    if (!body.startsWith('{')) continue
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed.touchedFiles)) parsed.touchedFiles.map(String).forEach(addFile)
      if (!out.diffSummary && typeof parsed.diffSummary === 'string') out.diffSummary = parsed.diffSummary
      if (!out.checks && typeof parsed.checks === 'string') out.checks = parsed.checks
    } catch (e) { /* ignore a broken fence */ }
  }

  // 3. The "Touched files:" section (any common paraphrase / heading / bold).
  const fileBlock = src.match(TOUCHED_HEAD_RE)
  if (fileBlock) {
    for (const path of collectBlockPaths(fileBlock[1])) addFile(path)
  }

  // 4. "Diff summary:" and "Checks:" labels, optionally bold or under a heading.
  const diff = src.match(new RegExp(
    '(?:^|\\n)[ \\t]*' + SECTION_HEAD + 'Diff\\s+summary\\*{0,2}[ \\t]*:\\*{0,2}[ \\t]*' +
    '([\\s\\S]*?)(?=\\n[ \\t]*' + SECTION_HEAD + '(?:Touched\\s+files?|Checks?|Tests?|Validation|Summary|Changes|Проверка|Тесты)\\*{0,2}[ \\t]*:' +
    '|\\n[ \\t]*#{1,6}[ \\t]+|$)',
    'i'
  ))
  if (diff) out.diffSummary = diff[1].trim()

  // "Checks:" is the documented label; "Tests:" / "Validation:" are the same
  // section under a different name. Optional bold or markdown heading.
  const CHECK_LABELS = ['Checks?', 'Tests?', 'Validation', 'Проверка', 'Тесты']
  for (const label of CHECK_LABELS) {
    if (out.checks) break
    const found = src.match(new RegExp(
      '(?:^|\\n)[ \\t]*' + SECTION_HEAD + label + '\\*{0,2}[ \\t]*:\\*{0,2}[ \\t]*' +
      '([\\s\\S]*?)(?=\\n[ \\t]*' + SECTION_HEAD +
      '(?:Touched\\s+files?|Diff\\s+summary|Checks?|Tests?|Validation|Проверка|Тесты)\\*{0,2}[ \\t]*:' +
      '|\\n[ \\t]*#{1,6}[ \\t]+|$)',
      'i'
    ))
    if (found) out.checks = found[1].trim()
  }

  // 5. Fallback when the section header was missing or unparseable: scan the
  //    whole answer for linked, backticked and bulleted file paths.
  if (out.touchedFiles.length === 0) {
    MD_LINK_RE.lastIndex = 0
    while ((m = MD_LINK_RE.exec(src)) !== null) addFile(m[1])
    BACKTICK_RE.lastIndex = 0
    while ((m = BACKTICK_RE.exec(src)) !== null) addFile(m[1])
    for (const line of src.split('\n')) {
      const t = line.trim()
      if (!BULLET_RE.test(t)) continue
      addFile(t.replace(BULLET_RE, ''))
    }
  }

  // 6. Fallback summary: the first prose line that is neither a section label
  //    nor a bare file bullet.
  if (!out.diffSummary && out.touchedFiles.length > 0) {
    for (const line of src.split('\n')) {
      const t = line.trim()
      if (!t) continue
      if (t.startsWith('```')) continue
      if (/^#{1,6}\s/.test(t)) continue
      if (SECTION_LINE_RE.test(t)) continue
      const head = t.replace(BULLET_RE, '').trim().split(/\s+/)[0] || ''
      if (head && cleanPathToken(head)) continue
      out.diffSummary = t.slice(0, 300)
      break
    }
  }

  return out
}
