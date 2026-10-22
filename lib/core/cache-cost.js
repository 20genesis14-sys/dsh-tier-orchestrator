// Cache-lapse telemetry — pure logic, no harness imports, no I/O.
//
// Smart mode keeps a long-lived main-agent session while sidekick/worker
// subagents run long tasks. While a child runs, the main agent idles; if the gap
// between two consecutive main-agent assistant messages exceeds the provider
// prompt-cache TTL (Anthropic short TTL = 5 min), the main agent's prefix cache
// goes cold and its next step pays one full prefix re-write at the cache-write
// tariff.
//
// This module turns a recorded step timeline plus child-run windows into a lapse
// analysis: lapse count, lapses attributable to child windows, estimated
// re-written prefix tokens (and USD when tariffs are supplied), the share of
// session spend, a material/negligible verdict, and a count-based
// recommendation for 1-hour cache retention. It is the pure half of the
// plugin's cache telemetry; the DSH event adapter that records the timeline
// lives in lib/dsh/.
//
// Everything here is a function of the arguments alone: no imports, no clock,
// no files, no network.

/** Anthropic's short prompt-cache TTL: a longer idle gap drops the prefix. */
export const DEFAULT_CACHE_TTL_MS = 300_000

/** A re-write worth >= this share of session spend is "material". */
export const DEFAULT_SHARE_THRESHOLD = 0.05

/** Attributable lapses per elapsed hour that justify asking for long retention. */
export const DEFAULT_LAPSES_PER_HOUR_THRESHOLD = 2

/** Below this many observed main-agent steps the verdict is not trustworthy. */
export const DEFAULT_MIN_LAPSES_FOR_VERDICT = 3

/** A finite number >= 0, else 0 (missing/NaN/Infinity/negative all mean "none"). */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** A finite option number, else the documented default. */
function optionNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A finite number >= 0 as-is, or null. */
function tariffRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Extract the cache-relevant counters from an adapter-reported TokenUsage.
 *
 * DSH reports camelCase counts (`inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheWriteTokens`); other fields such as `totalTokens` or
 * `reasoningTokens` are ignored. An absent or non-object usage means the adapter
 * reported nothing, which is different from a reported all-zero usage.
 *
 * @param usage - the TokenUsage-shaped object, or null/undefined.
 * @returns {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens} with
 *   every field a finite number >= 0, or null when usage is not an object.
 */
export function pickCacheUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cacheReadTokens),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
  }
}

/**
 * Tariffs are usable only when they are an object carrying all four rates as
 * finite numbers >= 0. A partial tariff block (e.g. nothing for `completion`)
 * cannot price a session honestly, so it is treated as absent rather than
 * guessed. Extra keys (a `cacheWrite1h` rate, say) are ignored.
 */
function usableTariffs(tariffs) {
  if (!tariffs || typeof tariffs !== 'object') return null
  const prompt = tariffRate(tariffs.prompt)
  const cacheRead = tariffRate(tariffs.cacheRead)
  const cacheWrite = tariffRate(tariffs.cacheWrite)
  const completion = tariffRate(tariffs.completion)
  if (prompt === null || cacheRead === null || cacheWrite === null || completion === null) return null
  return { prompt, cacheRead, cacheWrite, completion }
}

/**
 * Analyse a recorded main-agent step timeline against child-run windows.
 *
 * A *lapse* is a pair of consecutive kept steps whose gap exceeds the cache
 * TTL: the prefix cache died in between, so the second step pays a prefix
 * re-write. A lapse is *attributable* when at least one child window overlaps
 * the gap — evidence that the main agent was idle because a child was running
 * rather than because a human stepped away.
 *
 * `prefixTokens` is an approximation: the second step's input-side tokens
 * (`cacheRead + cacheWrite + input`) stand in for that step's full prompt
 * prefix, which is what a cold cache has to re-write. It is an estimate from
 * reported usage, not a provider-issued cache-miss number.
 *
 * @param steps - array of { ts (epoch ms), usage? } main-agent steps. Inputs are
 *   never mutated; steps with a non-finite ts are dropped and counted.
 * @param childWindows - array of { start, end } epoch-ms child-run windows.
 *   Non-finite bounds are dropped; end === start is kept (zero width, no
 *   overlap).
 * @param options - { ttlMs, shareThreshold, lapsesPerHourThreshold,
 *   minLapsesForVerdict, tariffs }. `tariffs` is { prompt, cacheRead,
 *   cacheWrite, completion } in USD per 1M tokens.
 * @returns the plain analysis object (see the return statement for the shape).
 */
export function analyzeCacheLapses(steps, childWindows = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const ttlMs = optionNumber(opts.ttlMs, DEFAULT_CACHE_TTL_MS)
  const shareThreshold = optionNumber(opts.shareThreshold, DEFAULT_SHARE_THRESHOLD)
  const lapsesPerHourThreshold = optionNumber(opts.lapsesPerHourThreshold, DEFAULT_LAPSES_PER_HOUR_THRESHOLD)
  const minLapsesForVerdict = optionNumber(opts.minLapsesForVerdict, DEFAULT_MIN_LAPSES_FOR_VERDICT)
  const tariffs = usableTariffs(opts.tariffs)

  // Keep a sorted, defensive copy: callers may hand over a live log array.
  const kept = []
  let skippedSteps = 0
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object' || typeof step.ts !== 'number' || !Number.isFinite(step.ts)) {
      skippedSteps++
      continue
    }
    kept.push({ ts: step.ts, usage: pickCacheUsage(step.usage) })
  }
  kept.sort(function (a, b) { return a.ts - b.ts })

  const windows = []
  for (const window of Array.isArray(childWindows) ? childWindows : []) {
    if (!window || typeof window !== 'object') continue
    if (typeof window.start !== 'number' || !Number.isFinite(window.start)) continue
    if (typeof window.end !== 'number' || !Number.isFinite(window.end)) continue
    windows.push({ start: window.start, end: window.end })
  }

  let totalInputSideTokens = 0
  let totalOutputTokens = 0
  let stepsWithoutUsage = 0
  let sessionCostUsd = 0
  for (const step of kept) {
    const usage = step.usage
    if (!usage) {
      stepsWithoutUsage++
      continue
    }
    totalInputSideTokens += usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens
    totalOutputTokens += usage.outputTokens
    if (tariffs) {
      sessionCostUsd += (usage.inputTokens * tariffs.prompt
        + usage.cacheReadTokens * tariffs.cacheRead
        + usage.cacheWriteTokens * tariffs.cacheWrite
        + usage.outputTokens * tariffs.completion) / 1e6
    }
  }

  const lapses = []
  let attributableLapseCount = 0
  let estimatedRewriteTokens = 0
  let actualRewriteTokens = 0
  let estimatedRewriteCostUsd = 0
  let actualRewriteCostUsd = 0
  for (let i = 1; i < kept.length; i++) {
    const t1 = kept[i - 1].ts
    const t2 = kept[i].ts
    const gapMs = t2 - t1
    if (!(gapMs > ttlMs)) continue
    let overlapMs = 0
    for (const window of windows) {
      const overlap = Math.min(window.end, t2) - Math.max(window.start, t1)
      if (overlap > 0) overlapMs += overlap
    }
    const second = kept[i].usage
    const prefixTokens = second ? second.cacheReadTokens + second.cacheWriteTokens + second.inputTokens : 0
    const writeTokens = second ? second.cacheWriteTokens : 0
    const attributable = overlapMs > 0
    if (attributable) attributableLapseCount++
    estimatedRewriteTokens += prefixTokens
    actualRewriteTokens += writeTokens
    if (tariffs) {
      estimatedRewriteCostUsd += prefixTokens * tariffs.cacheWrite / 1e6
      actualRewriteCostUsd += writeTokens * tariffs.cacheWrite / 1e6
    }
    lapses.push({ gapStartTs: t1, gapEndTs: t2, gapMs, overlapMs, attributable, prefixTokens })
  }

  let lapseShare = null
  if (tariffs) {
    if (sessionCostUsd > 0) lapseShare = estimatedRewriteCostUsd / sessionCostUsd
  } else if (totalInputSideTokens > 0) {
    // Without tariffs the honest denominator is the observed input-side volume
    // (read + write + fresh), i.e. the tokens the prefix cache is meant to save.
    lapseShare = estimatedRewriteTokens / totalInputSideTokens
  }

  let lapsesPerHour = null
  if (kept.length >= 2) {
    const spanHours = (kept[kept.length - 1].ts - kept[0].ts) / 3_600_000
    if (spanHours > 0) lapsesPerHour = attributableLapseCount / spanHours
  }

  let verdict
  if (kept.length < minLapsesForVerdict) verdict = 'insufficient-data'
  else if (lapseShare === null) verdict = 'unknown'
  else verdict = lapseShare >= shareThreshold ? 'material' : 'negligible'

  const recommendLongRetention = attributableLapseCount >= minLapsesForVerdict
    && lapsesPerHour !== null
    && lapsesPerHour >= lapsesPerHourThreshold

  return {
    keptSteps: kept.length,
    skippedSteps,
    stepsWithoutUsage,
    totalInputSideTokens,
    totalOutputTokens,
    childWindowCount: windows.length,
    lapseCount: lapses.length,
    attributableLapseCount,
    estimatedRewriteTokens,
    actualRewriteTokens,
    estimatedRewriteCostUsd: tariffs ? estimatedRewriteCostUsd : null,
    actualRewriteCostUsd: tariffs ? actualRewriteCostUsd : null,
    estimatedSessionCostUsd: tariffs ? sessionCostUsd : null,
    tariffsApplied: tariffs !== null,
    lapseShare,
    shareThreshold,
    lapsesPerHour,
    verdict,
    recommendLongRetention,
    lapses,
  }
}

/** Money for humans: cents when it matters, sub-cent precision otherwise. */
function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return '$' + (value >= 0.01 ? value.toFixed(2) : value.toFixed(4))
}

/** A count for humans: non-finite/garbage reads as 0. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Format an analysis into plain report lines (one per line, no ANSI, no
 * trailing newlines, no throwing).
 *
 * @param analysis - the object returned by analyzeCacheLapses.
 * @param extras - { usageFields: 'reported' | 'missing' | 'absent' | 'unknown',
 *   ttlMs } describing what the adapter could see.
 * @returns array of plain strings; ['cache telemetry: no data'] when there is
 *   nothing to describe.
 */
export function formatCacheLapseReport(analysis, extras = {}) {
  if (!analysis || typeof analysis !== 'object') return ['cache telemetry: no data']
  const ex = extras && typeof extras === 'object' ? extras : {}
  const usageFields = ['reported', 'missing', 'absent', 'unknown'].indexOf(ex.usageFields) !== -1 ? ex.usageFields : 'unknown'
  const ttlMs = optionNumber(ex.ttlMs, DEFAULT_CACHE_TTL_MS)
  const ttlMinutes = Math.round(ttlMs / 60000)

  const keptSteps = count(analysis.keptSteps)
  const stepsWithoutUsage = count(analysis.stepsWithoutUsage)
  const childWindowCount = count(analysis.childWindowCount)
  const lapseCount = count(analysis.lapseCount)
  const attributable = count(analysis.attributableLapseCount)
  const rewriteTokens = count(analysis.estimatedRewriteTokens)
  const share = typeof analysis.lapseShare === 'number' && Number.isFinite(analysis.lapseShare) ? analysis.lapseShare : null
  const verdict = typeof analysis.verdict === 'string' ? analysis.verdict : 'unknown'

  const lines = []
  let head = 'main steps observed: ' + keptSteps
    + ' (usage fields: ' + usageFields + ')'
    + ', child windows: ' + childWindowCount
  if (stepsWithoutUsage > 0) head += ', steps without usage: ' + stepsWithoutUsage
  lines.push(head)

  lines.push('lapses: ' + lapseCount + ' total, ' + attributable
    + ' attributable to child windows (ttl ' + ttlMinutes + ' min)')

  let cost = 'estimated prefix re-write: ' + rewriteTokens + ' tokens'
  const rewriteUsd = analysis.tariffsApplied === true ? money(analysis.estimatedRewriteCostUsd) : null
  if (rewriteUsd) {
    const rate = rewriteTokens > 0
      ? '$' + (count(analysis.estimatedRewriteCostUsd) / rewriteTokens * 1e6).toFixed(2) + '/1M'
      : null
    cost += ' (~' + rewriteUsd + (rate ? ' at ' + rate : '') + ')'
  }
  if (verdict === 'material' || verdict === 'negligible') {
    const shareText = share === null ? 'unknown' : (share * 100).toFixed(1) + '%'
    cost += '; share of session spend: ' + shareText + ' -> ' + verdict
  } else if (verdict === 'insufficient-data') {
    cost += '; share of session spend: unknown (insufficient data)'
  } else {
    cost += '; share of session spend: unknown'
  }
  lines.push(cost)

  if (analysis.recommendLongRetention === true) {
    const perHour = typeof analysis.lapsesPerHour === 'number' && Number.isFinite(analysis.lapsesPerHour)
      ? ' (' + analysis.lapsesPerHour.toFixed(1) + '/h)'
      : ''
    lines.push('hint: ' + attributable + ' cache lapse(s)' + perHour
      + ' attributable to child windows; consider cacheRetention: \'long\' on Anthropic-family'
      + ' main-role profiles in your own DSH config — this plugin reports the cost, it never'
      + ' changes request headers itself')
  }

  return lines
}
