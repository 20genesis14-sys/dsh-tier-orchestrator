// Decision-model transport — the only place that knows how a decision request
// reaches an endpoint. No DSH imports: a `{ state, questions }` decision
// request is plain data, and the wire is plain fetch (injectable for tests).
//
// Wire format (OpenRouter Decisions alpha, `/api/alpha/decisions`; any
// Jev-/System-One-compatible endpoint talks the same shape):
//   POST { model, state, questions }  ->  { answers: { id: { type, noul | choice | score, confidence } }, usage? }
//
// Failures never throw: every path returns a normalized `{ ok: false, ... }`
// so callers can fall back to their deterministic behavior.

import { parseDecisionAnswers, decideByThresholds, decisionKey } from '../core/decision.js'

const DEFAULT_BASE_URL = 'https://openrouter.ai'
const DEFAULT_PATH = '/api/alpha/decisions'
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_CACHE_TTL_MS = 60000

/**
 * Create the decision client for one configuration.
 * @param opts
 *   model       - decision model id (Jev / Clef / Drex / ... are all config).
 *   baseUrl     - endpoint origin (default https://openrouter.ai).
 *   path        - endpoint path (default /api/alpha/decisions).
 *   apiKey      - bearer token, sent only when non-empty.
 *   approveAt / blockAt - thresholds for `decideByThresholds`.
 *   timeoutMs   - per-request timeout (default 8000).
 *   cacheTtlMs  - identical-state result cache TTL (default 60000).
 *   fetchImpl   - injectable fetch (default globalThis.fetch).
 */
export function createDecisionClient(opts = {}) {
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const path = String(opts.path || DEFAULT_PATH).replace(/^([^/])/, '/$1')
  const apiKey = String(opts.apiKey || '')
  const model = String(opts.model || '')
  const approveAt = typeof opts.approveAt === 'number' && Number.isFinite(opts.approveAt) ? opts.approveAt : 0.9
  const blockAt = typeof opts.blockAt === 'number' && Number.isFinite(opts.blockAt) ? opts.blockAt : 0.1
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const cacheTtlMs = typeof opts.cacheTtlMs === 'number' && opts.cacheTtlMs > 0 ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  const cache = new Map()

  function cacheKey(questions, state) {
    // The model and thresholds are part of the identity: a config change must
    // never serve a stale decision.
    return model + '|' + approveAt + '|' + blockAt + '|' + decisionKey({ q: questions, s: state })
  }

  function cached(key, now) {
    const rec = cache.get(key)
    if (!rec) return null
    if (now - rec.at > cacheTtlMs) {
      cache.delete(key)
      return null
    }
    return rec.out
  }

  /**
   * Ask the decision model one question set.
   * @param questions - question map (see lib/core/decision.js builders).
   * @param state     - the decision state object.
   * @param extra     - { signal } optional abort signal.
   * @returns { ok, values, probabilities, outcome, usage?, cached? } or
   *   { ok: false, reason, outcome: 'unknown' } — never throws.
   */
  async function ask(questions, state, extra = {}) {
    if (!model) return { ok: false, reason: 'no decision model configured', outcome: 'unknown' }
    const key = cacheKey(questions, state)
    const now = Date.now()
    const hit = cached(key, now)
    if (hit) return { ...hit, cached: true }

    const url = baseUrl + path
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = 'Bearer ' + apiKey
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = extra.signal || undefined
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, state: state || {}, questions: questions || {} }),
        signal: combined,
      })
    } catch (e) {
      return { ok: false, reason: 'decision request failed: ' + String(e && e.message || e), outcome: 'unknown' }
    }

    let raw
    try {
      raw = await res.json()
    } catch (e) {
      return { ok: false, reason: 'decision response is not JSON (status ' + res.status + ')', outcome: 'unknown' }
    }
    if (!res.ok) {
      const detail = raw && (raw.error && raw.error.message || raw.message) || JSON.stringify(raw)
      return { ok: false, reason: 'decision endpoint error ' + res.status + ': ' + String(detail).slice(0, 200), outcome: 'unknown' }
    }

    const parsed = parseDecisionAnswers(raw, questions)
    if (!parsed.ok) return { ok: false, reason: parsed.reason, outcome: 'unknown' }
    const outcome = decideByThresholds(parsed.probabilities, { approveAt, blockAt })
    const out = { ok: true, values: parsed.values, probabilities: parsed.probabilities, outcome, usage: parsed.usage, cached: false }
    cache.set(key, { at: Date.now(), out })
    return out
  }

  return {
    ask,
    status() {
      return {
        configured: !!model,
        model,
        endpoint: url,
        approveAt,
        blockAt,
        timeoutMs,
        cacheTtlMs,
        cacheEntries: cache.size,
      }
    },
  }
}