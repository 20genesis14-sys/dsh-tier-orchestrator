// Consultation primitives — pure data, no harness imports.
//
// Every "ask a different model" feature (advisor, review, future delegation
// consults) reduces to one shape: a system prompt, a user-text builder, and a
// response post-processor. New consultations are registry entries, not new
// wiring.

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
      return { advice: text, ok: ok }
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
      return { verdict: verdict, review: text, ok: ok }
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
