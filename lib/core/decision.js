// Decision-model primitives — pure logic, no harness imports, no I/O.
//
// A decision model (Jev, Clef, Laya, ...) is not a generator: it answers
// narrow questions about a state with probabilities instead of prose. The wire
// format is `{ state, questions }` in and `{ answers: { id: { type, ... } } }`
// out. Everything here is plain data in, plain data out, so the whole decision
// layer stays unit-testable and the transport lives in lib/dsh/.
//
// Question types (Decisions API):
//   noul   — a yes/no proposition, answered with a probability in [0, 1]
//   choice — exactly one option out of `criteria`, with an optional confidence
//   score  — a numeric grade
//
// The model id is configuration, never code: any endpoint that speaks this
// format (OpenRouter Decisions, a self-hosted System One server, another
// vendor's decision model) is reachable by changing configuration alone.

/** Question types this module can build and parse. */
export const DECISION_QUESTION_TYPES = ['noul', 'choice', 'score']

/** Stages of the plugin that may consult a decision model. */
export const DECISION_STAGES = ['guard', 'escalate', 'worker', 'consult']

/** Default approval / block thresholds (probabilities in [0, 1]). */
export const DEFAULT_APPROVE_AT = 0.9
export const DEFAULT_BLOCK_AT = 0.1

/** A yes/no question about the state. */
export function noulQuestion(instructions) {
  return { type: 'noul', instructions: String(instructions) }
}

/** A question answered with exactly one of `criteria`. */
export function choiceQuestion(instructions, criteria) {
  const out = { type: 'choice', instructions: String(instructions) }
  if (criteria && typeof criteria === 'object') out.criteria = { ...criteria }
  return out
}

/** A question answered with a number. */
export function scoreQuestion(instructions) {
  return { type: 'score', instructions: String(instructions) }
}

/**
 * Questions for the second stage of the tool guard.
 *
 * Each proposition is complete on its own and is either true or false of the
 * state, so every answer carries its own reason. The `serves_task` question
 * is dropped when no task text is known: a decision model judges a vague task
 * poorly, and a missing question is better than a misleading one.
 *
 * @param input - { commands, project, task }
 * @returns a question map keyed by question id.
 */
export function buildGuardQuestions(input) {
  const src = input && typeof input === 'object' ? input : {}
  const questions = {
    reversible: noulQuestion(
      'Every command in `commands` only reads or changes files inside `project` ' +
      'and can be undone with git or by rerunning it. It does not push, publish, ' +
      'deploy, delete files outside the project, change system settings, or send ' +
      'data to a network service.',
    ),
  }
  if (typeof src.project === 'string' && src.project.length > 0) {
    questions.within_project = noulQuestion('Every path in `commands` is inside `project`.')
  }
  if (typeof src.task === 'string' && src.task.trim().length > 0) {
    questions.serves_task = noulQuestion('Running `commands` is a reasonable next step toward `task`.')
  }
  return questions
}

/**
 * Question for picking the tier that should execute a task packet.
 * @param input - { candidates: [{ id, label, description }], task }
 */
export function buildTierQuestion(input) {
  const src = input && typeof input === 'object' ? input : {}
  const list = Array.isArray(src.candidates) ? src.candidates : []
  const criteria = {}
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0) continue
    criteria[c.id] = typeof c.description === 'string' && c.description.length > 0
      ? c.description
      : (typeof c.label === 'string' && c.label.length > 0 ? c.label : c.id)
  }
  return { tier: choiceQuestion('Which tier should execute this task?', criteria) }
}

/**
 * Question for triaging a step failure: was it the model, or the task?
 * @param input - { failure, tier }
 */
export function buildEscalationQuestion(input) {
  const src = input && typeof input === 'object' ? input : {}
  return {
    model_fault: noulQuestion(
      'The failure in `failure` is a model-capability failure — a stronger model ' +
      'would very likely have avoided it. A task that is simply wrong, ' +
      'under-specified, or impossible is not a model-capability failure.',
    ),
  }
}

/**
 * Question for deciding whether a consultation is worth its cost.
 * @param input - { question, tier }
 */
export function buildConsultQuestion(input) {
  const src = input && typeof input === 'object' ? input : {}
  return {
    needs_consult: noulQuestion(
      'The question in `question` cannot be answered reliably by the model that is ' +
      'running now, and a stronger model would change the answer.',
    ),
  }
}

/** State keys a decision request may carry. */
const STATE_KEYS = [
  'tier', 'mode', 'planActive', 'project', 'task', 'tool', 'policy',
  'question', 'focus', 'evidence', 'failure', 'packet', 'candidates', 'commands',
]

/**
 * Assemble the `state` object of a decision request: only known keys, no
 * undefined values, arrays copied.
 * @param input - plain object with any of the state keys.
 */
export function buildDecisionState(input) {
  const src = input && typeof input === 'object' ? input : {}
  const state = {}
  for (const key of STATE_KEYS) {
    if (src[key] === undefined || src[key] === null) continue
    if (Array.isArray(src[key])) state[key] = src[key].slice()
    else if (typeof src[key] === 'object') state[key] = { ...src[key] }
    else state[key] = src[key]
  }
  return state
}

/** Usage block of a decision response, when the endpoint reported one. */
function usageOf(raw) {
  const u = raw && typeof raw === 'object' ? raw.usage : null
  if (!u || typeof u !== 'object') return null
  return {
    input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
    output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
    cost: typeof u.cost === 'number' ? u.cost : undefined,
  }
}

/**
 * Parse a decision response into normalized values.
 *
 * Strict on purpose: a missing answer, an out-of-range probability or an
 * unknown choice option is an error, never a silent zero. A broken response
 * must not read as "approved".
 *
 * @param raw - the response body (object or JSON string).
 * @param questions - the question map that was asked.
 * @returns { ok, reason, values, probabilities, usage }
 */
export function parseDecisionAnswers(raw, questions) {
  const ids = questions && typeof questions === 'object' ? Object.keys(questions) : []
  const fail = (reason) => ({ ok: false, reason: reason, values: {}, probabilities: {}, usage: null })
  let body = raw
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch (e) { return fail('response body is not JSON') }
  }
  if (!body || typeof body !== 'object') return fail('no response body')
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : null
  if (!answers) return fail('response carried no answers')
  const values = {}
  const probabilities = {}
  for (const id of ids) {
    const question = questions[id] || {}
    const answer = answers[id]
    if (!answer || typeof answer !== 'object') return fail('missing answer: ' + id)
    const type = typeof answer.type === 'string' ? answer.type : question.type
    if (type === 'noul') {
      const p = answer.noul
      if (typeof p !== 'number' || !isFinite(p) || p < 0 || p > 1) {
        return fail('answer "' + id + '" is not a probability in [0,1]')
      }
      values[id] = p
      probabilities[id] = p
    } else if (type === 'choice') {
      const choice = answer.choice
      if (typeof choice !== 'string') return fail('answer "' + id + '" is not a choice')
      const criteria = question.criteria && typeof question.criteria === 'object' ? question.criteria : null
      if (criteria && !Object.prototype.hasOwnProperty.call(criteria, choice)) {
        return fail('answer "' + id + '" chose an unknown option: ' + choice)
      }
      values[id] = choice
      const confidence = answer.confidence
      if (typeof confidence === 'number' && isFinite(confidence) && confidence >= 0 && confidence <= 1) {
        probabilities[id] = confidence
      }
    } else if (type === 'score') {
      const value = typeof answer.score === 'number' ? answer.score : answer.value
      if (typeof value !== 'number' || !isFinite(value)) return fail('answer "' + id + '" is not a score')
      values[id] = value
    } else {
      return fail('unsupported answer type: ' + String(type))
    }
  }
  return { ok: true, reason: null, values: values, probabilities: probabilities, usage: usageOf(body) }
}

/**
 * Turn probabilities into an outcome.
 *
 *   every answer at or above `approveAt` -> 'approve'
 *   any answer at or below `blockAt`      -> 'block'
 *   everything else                       -> 'review' (ask a human)
 *   missing or malformed answer           -> 'unknown' (no decision)
 *
 * 'unknown' is never 'approve': a model that failed to answer has not
 * approved anything.
 */
export function decideByThresholds(probabilities, opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const approveAt = typeof options.approveAt === 'number' ? options.approveAt : DEFAULT_APPROVE_AT
  const blockAt = typeof options.blockAt === 'number' ? options.blockAt : DEFAULT_BLOCK_AT
  if (!probabilities || typeof probabilities !== 'object') return 'unknown'
  const values = []
  for (const key of Object.keys(probabilities)) {
    const p = probabilities[key]
    if (typeof p !== 'number' || !isFinite(p) || p < 0 || p > 1) return 'unknown'
    values.push(p)
  }
  if (values.length === 0) return 'unknown'
  for (const p of values) if (p <= blockAt) return 'block'
  for (const p of values) if (p < approveAt) return 'review'
  return 'approve'
}

/** Deterministic JSON with sorted keys (object key order must not matter). */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(value[k]) }).join(',') + '}'
}

/**
 * Cache key for one decision request: equal states must produce equal keys.
 * @param state - the state object sent with the request.
 */
export function decisionKey(state) {
  return stableStringify(state === undefined ? null : state)
}

/**
 * Whether a stage is enabled in the configured stage list.
 * @param stages - configured stage names.
 * @param stage - the stage to test.
 */
export function isDecisionStageEnabled(stages, stage) {
  if (!Array.isArray(stages)) return false
  return stages.indexOf(stage) !== -1
}
