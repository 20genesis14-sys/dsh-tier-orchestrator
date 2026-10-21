// Consultation primitives — pure data, no harness imports.
//
// Every "ask a different model" feature (advisor, review, future delegation
// consults) reduces to one shape: a system prompt, a user-text builder, and a
// response post-processor. New consultations are registry entries, not new
// wiring.

/**
 * Soft-parse structured sections (risks, nextSteps, issues, ...) out of a
 * consultation response. Prefers JSON; otherwise scans Markdown section
 * headers and collects bullet/ordered items until the next header or EOF.
 * Never throws; returns an object with one array per requested key (missing
 * keys are omitted).
 */
export function softParseSections(text, keys) {
  const src = String(text || '')
  const out = {}
  const trimmed = src.trim()

  // JSON object first.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      for (const key of keys) {
        const value = parsed[key]
        if (Array.isArray(value)) {
          out[key] = value.map((v) => typeof v === 'string' ? v : JSON.stringify(v)).filter(Boolean)
        } else if (typeof value === 'string' && value.trim()) {
          out[key] = [value.trim()]
        } else if (value && typeof value === 'object') {
          out[key] = [JSON.stringify(value)]
        }
      }
      if (Object.keys(out).length > 0) return out
    } catch (e) { /* fall through to Markdown scan */ }
  }

  // Markdown section scan. Section headers are lines that are hash-marked
  // (colon optional), bold-marked with a colon, or bare text with a colon —
  // bullet item lines ("- ...") never count as headers.
  const headers = []
  const addHeader = (match) => {
    const name = String(match[0])
      .replace(/^[\s#*]+/, '')
      .replace(/[:\s]+$/, '')
      .trim()
    if (name) headers.push({ at: match.index + match[0].length, name })
  }
  let m
  const hashRe = /(?:^|\n)\s*#{1,6}\s*[A-Za-z][A-Za-z0-9 /-]{0,60}\s*:?\s*(?=\n|$)/g
  while ((m = hashRe.exec(src)) !== null) addHeader(m)
  const boldRe = /(?:^|\n)\s*\*{1,2}(?!\s)[^*\n]+?\*\s*:\s*(?=\n|$)/g
  while ((m = boldRe.exec(src)) !== null) addHeader(m)
  const textRe = /(?:^|\n)\s*[A-Za-z][A-Za-z0-9 /-]{0,60}:\s*(?=\n|$)/g
  while ((m = textRe.exec(src)) !== null) addHeader(m)
  headers.sort((a, b) => a.at - b.at)
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
  const SECTION_ALIASES = {
    risks: ['risks', 'risk'],
    nextSteps: ['nextsteps', 'next'],
    acceptanceChecks: ['acceptance', 'acceptancechecks'],
  }
  for (let i = 0; i < headers.length; i++) {
    const name = norm(headers[i].name)
    let key = null
    for (const k of keys) {
      const aliases = SECTION_ALIASES[k] || [norm(k)]
      if (aliases.some((a) => name.includes(a))) { key = k; break }
    }
    if (!key) continue
    const start = headers[i].at
    const end = i + 1 < headers.length ? headers[i + 1].at : src.length
    const block = src.slice(start, end)
    const items = []
    const itemRe = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s*(.+?)\s*(?=\n|$)/g
    let im
    while ((im = itemRe.exec(block)) !== null) {
      const t = im[1].trim()
      if (t) items.push(t)
    }
    if (items.length === 0) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
      for (const line of lines) {
        const stripped = line.replace(/^[\s#*\-]+/, '')
        if (/^[A-Za-z][A-Za-z0-9 /-]{0,40}:\s*$/.test(stripped)) break
        if (line.startsWith('#')) break
        items.push(line)
      }
    }
    if (items.length > 0 && !out[key]) out[key] = items
  }
  return out
}

export const CONSULTS = {
  advisor: {
    kind: 'advisor',
    system: [
      'You are the Tier Advisor: the strong-tier consultant for a coding agent that implements work in a cheaper model.',
      'Answer ONE explicit decision question using the provided evidence. Do not implement; do not take over the task.',
      'Return, in order: Recommendation; Decisive evidence; Rejected alternatives; Risks; Implementation constraints; Acceptance criteria; Remaining uncertainty.',
      'If the evidence is insufficient, state the cheapest additional check needed instead of guessing. Be concise.',
    ].join('\n'),
    buildUser(input) {
      return 'Decision question:\n' + input.question + (input.evidence ? '\n\nEvidence:\n' + input.evidence : '')
    },
    parse(text, ok) {
      const sections = softParseSections(text, ['risks', 'nextSteps', 'acceptanceChecks'])
      return { advice: text, ok: ok, ...sections }
    },
  },
  review: {
    kind: 'review',
    system: [
      'You are the Tier Reviewer: an independent strong-tier reviewer for a coding agent.',
      'Review the provided work state and evidence for correctness, security, data integrity, compatibility, and completeness.',
      'Return, in order: Verdict (APPROVE or NEEDS-CHANGES or BLOCKED); Issues ranked by severity with concrete fixes; Unverified claims; Recommended follow-ups.',
      'Only claim what the evidence supports. Be concise.',
    ].join('\n'),
    buildUser(input) {
      return 'Review focus:\n' + input.focus + (input.evidence ? '\n\nEvidence:\n' + input.evidence : '')
    },
    parse(text, ok) {
      let verdict = 'FAILED'
      if (ok) {
        const first = String(text).split('\n')[0] || ''
        const match = first.match(/APPROVE|NEEDS-CHANGES|BLOCKED/i)
        verdict = match ? match[0].toUpperCase() : 'UNPARSED'
      }
      const sections = softParseSections(text, ['issues'])
      return { verdict: verdict, review: text, ok: ok, ...sections }
    },
  },
}

/**
 * Model family for the reviewer-independence check: the series token of the
 * model id, after any vendor path ("deepseek-v4-pro" -> "deepseek",
 * "gpt-5.6-terra" -> "gpt", "minimax/minimax-m3.1-flash" -> "minimax"). A
 * heuristic: routes of one lineage share blind spots whatever provider serves them.
 */
export function modelFamily(model) {
  const last = String(model || '').split('/').pop().toLowerCase()
  const match = last.match(/^[a-z]+/)
  return match ? match[0] : last
}

/**
 * Implementers that share the reviewer's model family.
 * @param reviewer - { provider, model }
 * @param implementers - [{ label, provider, model }]
 * @returns the same-family implementers (empty when the reviewer is independent).
 */
export function reviewerConflicts(reviewer, implementers) {
  const family = modelFamily(reviewer.model)
  return implementers.filter(function (i) { return modelFamily(i.model) === family })
}

/**
 * Look up a consultation definition by kind.
 * @returns the consult spec, or undefined for unknown kinds.
 */
export function consultSpec(kind) {
  return CONSULTS[kind]
}
