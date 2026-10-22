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

// Phase vocabulary a future `ask` policy would extend (the state machine
// below is: idle → counting → escalated, plus the reserved 'awaiting-confirm'
// slot). It stays a comment rather than an export: nothing reads it.

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

/**
 * Tools that read the repository: they count toward the plan-exploration gate.
 * `ops_read_files` reads UTF-8 ranges (the ops file tool), and the
 * `tier_sidekick` explore stage reads through a delegated child, so both are
 * legitimate exploration the gate must credit.
 */
export const EXPLORE_TOOLS = ['read', 'glob', 'grep', 'ops_read_files']

// Direct read/search calls the Main Agent may make per turn in smart mode.
// Two calls are allowed; the 3rd (or any ops_read_files batch of >= 3 files)
// is denied so it delegates the reading to tier_sidekick(stage: "explore").
export const SMART_MAIN_READ_BUDGET = 2

/**
 * Decide whether a direct read/search tool call by the Main Agent in smart
 * mode is within the per-turn read budget. Reading >=3 files (either via
 * a 3rd read/search call or an ops_read_files batch of >=3 files) is
 * denied so the Main Agent delegates to tier_sidekick(stage: "explore").
 * @param readsUsed - direct read/search count already used since turn start or last explore.
 * @param toolName  - the tool being called.
 * @param toolArgs  - parsed tool arguments.
 * @param maxReads  - max allowed direct read/search calls (default 2, so the 3rd call is denied).
 * @returns { action: 'allow' | 'deny', nextReads: number, reason?: string }
 */
export function decideSmartReadBudget(readsUsed, toolName, toolArgs, maxReads = SMART_MAIN_READ_BUDGET) {
  const used = typeof readsUsed === 'number' && readsUsed > 0 ? Math.floor(readsUsed) : 0
  if (EXPLORE_TOOLS.indexOf(toolName) === -1) return { action: 'allow', nextReads: used }
  const max = typeof maxReads === 'number' && maxReads >= 0 ? Math.floor(maxReads) : SMART_MAIN_READ_BUDGET
  // A single ops_read_files call may carry several files: it costs what it reads.
  const batchCount = toolName === 'ops_read_files' && toolArgs && Array.isArray(toolArgs.files)
    ? Math.max(1, toolArgs.files.length)
    : 1
  if (batchCount >= 3 || used >= max || used + batchCount > max) {
    return {
      action: 'deny',
      nextReads: used,
      reason: 'Smart mode read budget (' + max + ' direct read/search calls) reached: when searching or reading >=3 files, delegate to `tier_sidekick` with stage "explore" to keep the Main Agent context clean and populate the TurboQuant cache. Calling `tier_sidekick(stage: "explore")` resets your direct read budget. Check `tier_recall` first — the answer may already sit in project memory.',
    }
  }
  return { action: 'allow', nextReads: used + batchCount }
}

/**
 * Decide whether one more advisor call in the current turn is allowed.
 * @param callsInTurn     - advisor calls already made this user turn.
 * @param maxCalls        - per-turn limit without asking (advisorMaxCallsPerTurn).
 * @param confirmTimeoutSec - seconds to wait for user approval on the next
 *                           call (0 = never ask).
 * @returns { action: 'allow' | 'ask' | 'deny', timeoutMs?, reason? } —
 *   'ask' hands the decision to the user (approval seam) and carries the
 *   timeout; 'deny' is the deterministic fail path when confirmation is not
 *   possible.
 */
export function decideAdvisorBudget(callsInTurn, maxCalls, confirmTimeoutSec) {
  const max = typeof maxCalls === 'number' && maxCalls > 0 ? Math.floor(maxCalls) : 0
  const calls = typeof callsInTurn === 'number' && callsInTurn > 0 ? Math.floor(callsInTurn) : 0
  if (calls < max) return { action: 'allow' }
  if (typeof confirmTimeoutSec === 'number' && confirmTimeoutSec > 0) {
    return { action: 'ask', timeoutMs: Math.floor(confirmTimeoutSec * 1000) }
  }
  return {
    action: 'deny',
    reason: 'Advisor call denied: per-turn limit (' + max + ') reached and user confirmation is disabled (advisorConfirmTimeoutSec = ' + String(confirmTimeoutSec) + ').',
  }
}

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
      reason: 'explore before presenting the plan: ' + spec.explored + ' read/search call(s) since plan mode started, at least ' + spec.minExplore + ' needed. Read the code the plan depends on (read, glob, grep, ops_read_files, or tier_sidekick stage "explore"), then call exit_plan_mode again.',
    }
  }
  if (spec.advisorGate && !spec.consulted) return { action: 'consult' }
  return { action: 'allow' }
}
