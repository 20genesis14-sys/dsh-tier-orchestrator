// Model capability probe — what one provider/model route actually declares.
//
// The `agent/request` waterfall runs on every step, so the metadata read is
// cached per route. Two facts matter to the router: whether the model declares
// reasoning support at all (undefined = send no reasoningEffort), and which
// effort ids it accepts (deepseek-v4-flash has no `medium`).
//
// Failure policy: an unreachable or throwing `resolveModelInfo` yields
// `known: false`, which the caller treats as "leave the target untouched" —
// the router never guesses a model's capabilities.

/**
 * @param llm  - the probed `llm` service (may be undefined).
 * @param ttlMs - metadata cache TTL (routes change rarely; effort does not).
 */
export function createModelCapabilities(llm, ttlMs) {
  const ttl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : 300000
  const cache = new Map()
  const usable = !!llm && typeof llm.resolveModelInfo === 'function'

  function keyOf(provider, model) { return provider + '\u0000' + model }

  function cached(provider, model) {
    const hit = cache.get(keyOf(provider, model))
    if (!hit) return undefined
    return Date.now() - hit.at < ttl ? hit.value : undefined
  }

  /**
   * Read one route's reasoning declaration.
   * @returns { known, reasoning } — known false when metadata is unavailable.
   */
  async function reasoningOf(provider, model, signal) {
    if (!usable || typeof provider !== 'string' || typeof model !== 'string') return { known: false }
    const hit = cached(provider, model)
    if (hit) return hit
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      const value = { known: true, reasoning: info && info.reasoning }
      cache.set(keyOf(provider, model), { at: Date.now(), value })
      return value
    } catch (e) {
      return { known: false }
    }
  }

  /** Cache-only read for synchronous paths (no metadata fetch). */
  function peek(provider, model) {
    return cached(provider, model)
  }

  function invalidate() { cache.clear() }

  return { usable, reasoningOf, peek, invalidate }
}
