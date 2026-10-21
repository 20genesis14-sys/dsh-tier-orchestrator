// Escalation & guard policy — pure decision functions.
//
// The policy layer is deliberately a value-to-value mapping so that future
// behaviors (ask-before-escalate, per-tier policies, custom thresholds) slot
// in as new action kinds rather than rewrites of the wiring layer.
//
// Action vocabulary (extension point):
//   'route'        — change the request target now
//   'deny'         — block a tool call with an escalation hint
//   'escalate'     — temporarily move the session to a stronger tier
//   'raise-effort' — bump the weak tier's reasoning effort one step
//   'fallback'     — advance the tier's fallback chain
//   'ask'          — RESERVED: hand the decision to the user before acting
//   'none'         — no action

import { classifyFallback } from './routing.js'

/** Per-agent failure-escalation state machine phases (documented for future
 *  'ask' support: 'awaiting-confirm' is the slot a confirm-policy would use). */
export const ESCALATION_PHASES = ['idle', 'counting', 'escalated']

/**
 * Advance the escalation counter for one observed step error.
 * @param rec   - previous record { count, windowStart, until } or undefined.
 * @param now   - current timestamp (ms).
 * @param opts  - { threshold, windowMs, ttlMs }.
 * @returns { rec, escalated } — the record to store and whether a new
 *   escalation window opened on this error.
 */
export function escalationStep(rec, now, opts) {
  const threshold = opts && typeof opts.threshold === 'number' ? opts.threshold : 2
  const windowMs = opts && typeof opts.windowMs === 'number' ? opts.windowMs : 60000
  const ttlMs = opts && typeof opts.ttlMs === 'number' ? opts.ttlMs : 180000
  if (!rec || typeof rec.windowStart !== 'number' || now - rec.windowStart > windowMs) {
    rec = { count: 0, windowStart: now, until: 0 }
  }
  rec = { count: rec.count + 1, windowStart: rec.windowStart, until: rec.until || 0 }
  const escalated = rec.count >= threshold && rec.until < now
  if (escalated) rec.until = now + ttlMs
  return { rec, escalated }
}

/**
 * Whether an escalation record currently grants the strong tier.
 * A counting record (until === 0) is kept alive between errors; expired
 * escalations are reported as inactive and may be deleted by the caller.
 */
export function escalationActive(rec, now) {
  if (!rec || typeof rec.until !== 'number') return false
  if (rec.until > now) return true
  return false
}

/** Whether an escalation record is garbage-collectable (expired, non-counting). */
export function escalationExpired(rec, now) {
  return !!rec && typeof rec.until === 'number' && rec.until > 0 && rec.until <= now
}

/**
 * Decide what one `tools/pre-execute` observation should do.
 * @param tier    - the caller's effective execution tier name, or null.
 * @param hit     - the high-impact match description (or null).
 * @param weakTier- the weakest tier name (denials apply while it executes).
 * @returns { action: 'allow' | 'deny' | 'ask', reason?: string }
 *   'ask' is reserved for a future confirmation policy and never returned yet.
 */
export function decideGuardAction(tier, hit, weakTier) {
  if (tier !== weakTier) return { action: 'allow' }
  if (!hit) return { action: 'allow' }
  return { action: 'deny', reason: hit }
}

/**
 * Decide what one `agent/error` observation should do: count the failure,
 * possibly open an escalation window, and raise the weak tier's effort when
 * the failure is not a known non-model cause. Fallback-chain advancement is a
 * separate seam (`agent/request-error`), classified by `classifyFallback`.
 * @param failure   - the normalized failure object.
 * @param rec       - current escalation record for the agent.
 * @param failedTier- the tier that produced the failure.
 * @param weakTier  - the weakest tier name (effort raises apply there).
 * @param opts      - escalation thresholds for escalationStep (+ now).
 * @returns { actions: Array<'escalate'|'raise-effort'>, rec, classification }
 */
export function decideErrorActions(failure, rec, failedTier, weakTier, opts) {
  const now = opts && typeof opts.now === 'number' ? opts.now : Date.now()
  const cls = classifyFallback(failure)
  // Ignored failures (caller aborts, context overflow, empty responses that
  // DSH retries itself) are not model faults: they must not advance the
  // escalation counter at all, or two unrelated aborts pin the session to
  // the strong tier for minutes.
  if (cls === 'ignore') return { actions: [], rec: rec, classification: cls }
  const step = escalationStep(rec, now, opts)
  const actions = []
  if (step.escalated) actions.push('escalate')
  if (!step.escalated && failedTier === weakTier) actions.push('raise-effort')
  return { actions, rec: step.rec, classification: cls }
}

/** Tools that read the repository: they count toward the plan-exploration gate. */
export const EXPLORE_TOOLS = ['read', 'glob', 'grep']

/**
 * Decide whether exit_plan_mode may present the plan now.
 * @param spec
 *   planActive:   plan mode is active when the exit is requested.
 *   explored:     read/search calls since plan mode started.
 *   minExplore:   how many such calls the plan needs first.
 *   advisorGate:  whether an advisor review is required once per plan.
 *   consulted:    whether this plan already had its advisor review.
 * @returns { action: 'allow' | 'deny' | 'consult', reason? } - 'consult' asks
 *   the caller to run the advisor and deny with its advice.
 */
export function decidePlanExit(spec) {
  if (!spec.planActive) return { action: 'allow' }
  if (spec.explored < spec.minExplore) {
    return {
      action: 'deny',
      reason: 'explore before presenting the plan: ' + spec.explored + ' read/search call(s) since plan mode started, at least ' + spec.minExplore + ' needed. Read the code the plan depends on (read, glob, grep), then call exit_plan_mode again.',
    }
  }
  if (spec.advisorGate && !spec.consulted) return { action: 'consult' }
  return { action: 'allow' }
}
