// Config bridge — how the agent-plane instance reaches the durable,
// user-editable configuration that lives on the host-row entry.
//
// DSH 0.2 persistence model: a plugin's `Config` schema declares volatile
// fields; the SettingsForms service projects them into the WebUI settings
// page and persists user edits into the profile patch. The host row
// (`id: tier-routing`) owns those volatile fields; the agent-plane row inside
// the `tiered` preset reads them back through `settings.describe()` and
// writes through `settings.update(ns, patch)`.
//
// When the settings service is unreachable (preset isolation, older hosts),
// the bridge degrades to "in-memory only" and says so honestly.

export const HOST_SETTINGS_NS = 'tier-routing'

/** Read one volatile-or-plain config field (Volatile refs carry .get()). */
export function vol(x) {
  if (x && typeof x === 'object' && typeof x.get === 'function') {
    try { return x.get() } catch (e) { return undefined }
  }
  return x
}

/**
 * @param settings - the probed `settings` service (may be undefined).
 * @param ns       - the profile entry id holding the volatile fields.
 * @param ttlMs    - describe() cache TTL (freshness vs per-step cost).
 */
export function createConfigBridge(settings, ns, ttlMs) {
  const ttl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : 2000
  let cache = null
  let cacheAt = 0
  const readable = !!settings && typeof settings.describe === 'function'
  const writable = !!settings && typeof settings.update === 'function'

  function read() {
    if (!readable) return null
    const now = Date.now()
    if (cache && now - cacheAt < ttl) return cache
    try {
      const entries = settings.describe() || []
      for (const d of entries) {
        if (d && d.ns === ns && d.value && typeof d.value === 'object') {
          cache = d.value
          cacheAt = now
          return cache
        }
      }
    } catch (e) {
      cache = null
    }
    return cache
  }

  async function write(patch) {
    if (!writable) throw new Error('settings.update is unavailable')
    await settings.update(ns, patch)
    cache = null
  }

  function invalidate() { cache = null }

  return {
    readable: readable,
    writable: writable,
    read: read,
    write: write,
    invalidate: invalidate,
  }
}
