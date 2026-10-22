// Cache-lapse telemetry adapter — folds ordinary DSH session events into the
// bounded per-agent timeline that `lib/core/cache-cost.js` analyses.
//
// Smart mode leaves the main agent idle while a sidekick/worker child runs. If
// that idle gap exceeds the provider prompt-cache TTL, the main agent's next
// step pays a full prefix re-write. This module records *when* the main agent
// produced an assistant message and *what* cache counters its usage reported
// (plus the child-run windows the tool handlers time themselves); it never
// decides anything, never prices anything and never changes a request.
//
// It is shape knowledge only: a DSH `assistant/message` session event carries
// `{ type, seq, time, data: { usage } }`, and `usage` is camelCase TokenUsage
// (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) — DSH
// has no 1-hour cache bucket field, so nothing here invents one.
//
// Contract: no harness imports, no I/O, no clock of its own, no throwing. An
// unrecognized event is ignored (returns false) and the report says honestly
// that no usage was observed. Prices, verdicts and wording stay in core.

import { pickCacheUsage } from '../core/cache-cost.js'

/** Bound on the retained step timeline: enough for a long session's lapses. */
export const MAX_TELEMETRY_STEPS = 200

/** Bound on the retained child-run windows: one per sidekick/worker spawn. */
export const MAX_TELEMETRY_WINDOWS = 100

/**
 * A fresh, empty timeline for one agent.
 *
 * `usageFields` starts as 'unknown' — no `assistant/message` event has been seen
 * yet — and becomes 'reported' or 'absent' from the first one on.
 */
export function createCacheTelemetry() {
  return { steps: [], childWindows: [], usageFields: 'unknown' }
}

/** A state object this module can write to (never throws on garbage). */
function writable(state) {
  return !!state && typeof state === 'object'
}

/** Push one entry and keep the log bounded by dropping the oldest. */
function pushBounded(list, entry, max) {
  list.push(entry)
  while (list.length > max) list.shift()
}

/**
 * Record one main-agent assistant message.
 *
 * Read-only with respect to the event: values are copied out of
 * `event.data.usage` with `pickCacheUsage` (missing fields become 0, a
 * non-object usage becomes null). A usage object is recorded as 'reported';
 * a message with no usable usage is recorded anyway (its timestamp still
 * matters for lapse detection) and marks the state 'absent'.
 *
 * @param state - a createCacheTelemetry() state.
 * @param event - the raw `session/event` payload.
 * @returns true when a step was recorded, false when the event was not a
 *   recordable assistant message (state untouched).
 */
export function recordAssistantMessage(state, event) {
  if (!writable(state) || !Array.isArray(state.steps)) return false
  if (!event || typeof event !== 'object') return false
  if (event.type !== 'assistant/message') return false
  const ts = event.time
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false
  let usage = null
  try {
    const data = event.data && typeof event.data === 'object' ? event.data : null
    usage = data ? pickCacheUsage(data.usage) : null
  } catch (e) {
    usage = null
  }
  // 'absent' covers both "data is not an object" and "data.usage is missing":
  // the step is real, the counters are not.
  state.usageFields = usage ? 'reported' : 'absent'
  pushBounded(state.steps, { ts, usage }, MAX_TELEMETRY_STEPS)
  return true
}

/**
 * Record one child-run window (the time a sidekick/worker child kept the main
 * agent idle). The handler that spawns the child times it: a child session's
 * events are not parent events, so the window cannot be derived from the
 * parent's stream.
 *
 * @param state - a createCacheTelemetry() state.
 * @param startMs - epoch ms when the child was started.
 * @param endMs - epoch ms when the child completed/disposed.
 * @returns true when the window was recorded, false on unusable bounds
 *   (state untouched).
 */
export function recordChildWindow(state, startMs, endMs) {
  if (!writable(state) || !Array.isArray(state.childWindows)) return false
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return false
  if (typeof endMs !== 'number' || !Number.isFinite(endMs)) return false
  if (endMs < startMs) return false
  pushBounded(state.childWindows, { start: startMs, end: endMs }, MAX_TELEMETRY_WINDOWS)
  return true
}

/**
 * A defensive snapshot for the analyser: new arrays with shallow-copied
 * entries, so a caller never receives (or can mutate) the live logs. Entries
 * that are not objects survive as non-finite records, which core drops and
 * counts instead of trusting.
 *
 * @param state - a createCacheTelemetry() state (garbage reads as empty).
 * @returns {steps, childWindows, usageFields}.
 */
export function telemetrySnapshot(state) {
  const s = writable(state) ? state : createCacheTelemetry()
  const steps = Array.isArray(s.steps) ? s.steps : []
  const childWindows = Array.isArray(s.childWindows) ? s.childWindows : []
  return {
    steps: steps.map((step) => (step && typeof step === 'object'
      ? { ts: step.ts, usage: step.usage && typeof step.usage === 'object' ? { ...step.usage } : null }
      : { ts: NaN, usage: null })),
    childWindows: childWindows.map((window) => (window && typeof window === 'object'
      ? { start: window.start, end: window.end }
      : { start: NaN, end: NaN })),
    usageFields: typeof s.usageFields === 'string' ? s.usageFields : 'unknown',
  }
}
