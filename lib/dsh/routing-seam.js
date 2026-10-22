// Routing seams — how a decided tier reaches the actual model request.
//
// Strategies, best-first:
//   'waterfall' — the `agent/request` waterfall (DSH >= 0.2): each request's
//     frozen call config passes through listeners; returning a replacement
//     switches provider/model/effort immediately and the loop logs the
//     request/header change itself. No one-step delay, no manual appends.
//   'header'    — legacy path (DSH <= 0.1.x): mutate agent.options and append
//     a `request/header` event; applies from the next step.
//
// Selection is a config/probe decision made once at mount; both strategies
// share the same `resolve(agent, seedConfig)` callback supplied by index.js,
// so policy code never knows which seam carried it.

/**
 * Mount the `agent/request` waterfall strategy.
 * @param ctx   - plugin context.
 * @param resolve - (agent, seedConfig) => target {provider, model,
 *   reasoningEffort} or null to leave the seed untouched; may be async so the
 *   router can reconcile the effort with the model's declared capabilities.
 * @param diag  - counters (requestSteps, lastRouting).
 * @returns true when the listener registered.
 */
export function mountRequestWaterfall(ctx, resolve, diag) {
  if (typeof ctx.on !== 'function') return false
  try {
    ctx.on('agent/request', async (payload, next) => {
      diag.requestSteps = diag.requestSteps + 1
      let seed
      try {
        seed = await next()
      } catch (e) {
        // The waterfall broke below us; do not mask the real error.
        throw e
      }
      if (!seed || typeof seed !== 'object') return seed
      try {
        const agent = payload && payload.agent
        const target = await resolve(agent, seed)
        if (!target) return seed
        const effort = target.reasoningEffort
        if (seed.provider === target.provider && seed.model === target.model
          && seed.reasoningEffort === effort) return seed
        diag.lastRouting = 'request #' + diag.requestSteps + ': ' + seed.provider + '/' + seed.model
          + ' -> ' + target.provider + '/' + target.model + ' (' + (effort || 'no effort') + ')'
        // An undefined effort is a decision, not an omission: the model declares
        // no reasoning support, so the seed's effort must not ride along either.
        const routed = { ...seed, provider: target.provider, model: target.model }
        if (effort !== undefined) routed.reasoningEffort = effort
        else delete routed.reasoningEffort
        return routed
      } catch (e) {
        diag.lastRouting = 'request #' + diag.requestSteps + ': routing failed (' + String(e && e.message || e) + '), seed preserved'
        return seed
      }
    })
    return true
  } catch (e) {
    return false
  }
}

/**
 * Legacy strategy helpers: mutate agent.options and append a durable
 * `request/header` so the loop's next step builds on the new route.
 */
export function headerOf(session) {
  try { return session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined } catch (e) { return undefined }
}

export function headerConfigOf(session) {
  const header = headerOf(session)
  return header ? header.config : undefined
}

/**
 * Write a `request/header` change event (legacy routing + immediate-apply
 * path). Keeps unrelated header fields (`maxTokens`, stops) untouched.
 */
export function writeHeaderRoute(agent, target, diag) {
  if (!agent || !target) return false
  try {
    const session = agent.session
    if (!session || typeof session.append !== 'function' || typeof session.requestHeader !== 'function') return false
    const cur = headerConfigOf(session)
    if (cur && cur.provider === target.provider && cur.model === target.model && cur.reasoningEffort === target.reasoningEffort) return false
    // A config field is present or absent, never undefined: the session append
    // validation rejects an undefined value, and a route whose model declares
    // no reasoning support must not carry one.
    const config = { ...(cur || {}), provider: target.provider, model: target.model }
    if (target.reasoningEffort !== undefined) config.reasoningEffort = target.reasoningEffort
    else delete config.reasoningEffort
    session.append('request/header', {
      header: { config },
      reason: 'change',
    })
    if (diag) {
      diag.headerWrites = diag.headerWrites + 1
      diag.lastHeader = 'wrote ' + target.provider + '/' + target.model + ' (' + (target.reasoningEffort || 'no effort') + ') for ' + String(agent.id)
    }
    return true
  } catch (e) {
    if (diag) diag.lastHeader = 'header write failed: ' + String(e && e.message || e)
    return false
  }
}

/**
 * Legacy immediate-apply: keep `agent.options` (first/resumed request source)
 * and the durable header in sync.
 */
export function applyHeaderRoute(agent, target, diag) {
  if (!agent || !target) return
  try {
    if (agent.options && typeof agent.options === 'object') {
      agent.options.provider = target.provider
      agent.options.model = target.model
      // Symmetric with the header write: a route without reasoning support
      // must not inherit the previous tier's effort (the first/resumed request
      // is built from these options).
      if (target.reasoningEffort !== undefined) agent.options.reasoningEffort = target.reasoningEffort
      else delete agent.options.reasoningEffort
    }
  } catch (e) {}
  writeHeaderRoute(agent, target, diag)
}
