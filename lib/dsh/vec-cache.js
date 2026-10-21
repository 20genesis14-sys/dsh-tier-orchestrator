// TurboQuant cache adapter — persistence + bounded evidence reads on top of
// the pure `core/turbovec.js` index. This is the only place that touches the
// filesystem (`ctx.fs`), and it degrades to in-memory operation when the fs
// service or any needed method is missing.

import { createTurboQuantIndex } from '../core/turbovec.js'

export const CACHE_FILE_NAME = '.dsh-turbovec-cache.json'
export const CACHE_MAX_FILE_BYTES = 12288
export const CACHE_MAX_TOTAL_BYTES = 36864
// The serialized cache state must stay small enough to be written and read
// back cheaply by the host: the oldest entries are dropped when it grows
// past this bound (256 KiB).
export const CACHE_MAX_STATE_BYTES = 262144

/**
 * Safely read a list of file paths for evidence (advisor/review `paths[]`
 * and sidekick `paths[]`). Caps per-file and total bytes; unreadable or
 * non-text files are skipped silently.
 * @param paths - string[] (or object with .paths).
 * @param opts - { fs, seams, cwd, maxFileBytes, maxTotalBytes }.
 * @returns [{ path, text }] with truncated text.
 */
export async function readEvidencePaths(paths, opts = {}) {
  const list = Array.isArray(paths) ? paths : (paths && Array.isArray(paths.paths) ? paths.paths : [])
  const fsService = opts.fs || null
  const seams = opts.seams || {}
  const cwd = opts.cwd
  const maxFileBytes = opts.maxFileBytes ?? CACHE_MAX_FILE_BYTES
  const maxTotalBytes = opts.maxTotalBytes ?? CACHE_MAX_TOTAL_BYTES
  const canRead = !!(fsService && seams.fsResolve && seams.fsReadText)
  const out = []
  let total = 0
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (total >= maxTotalBytes) break
    if (!canRead) continue
    try {
      const target = await fsService.resolve(raw, cwd !== undefined ? { cwd } : {})
      const text = await fsService.readText(target)
      if (typeof text === 'string') {
        const truncated = text.length > maxFileBytes
          ? text.slice(0, maxFileBytes) + '\n[truncated]'
          : text
        total += truncated.length
        out.push({ path: raw, text: truncated })
      }
    } catch (e) { /* unreadable file: skip */ }
  }
  return out
}

/**
 * TurboQuant cache facade: in-memory index + debounced persistence through
 * `ctx.fs`. All mutations schedule a save; with no writable fs the cache is
 * memory-only (honest `persistent: false`).
 */
export function createVecCache(options = {}) {
  const fsService = options.fs || null
  const seams = options.seams || {}
  const cwd = options.cwd
  const sandboxPolicy = options.sandboxPolicy || null
  const getSession = typeof options.getSession === 'function' ? options.getSession : () => undefined
  const debounceMs = options.debounceMs ?? 1000
  const index = createTurboQuantIndex({ dim: options.dim, maxEntries: options.maxEntries })
  const canWrite = !!(fsService && seams.fsResolve && seams.fsWriteText)
  const canRead = !!(fsService && seams.fsResolve && seams.fsReadText)
  let timer = null
  let saving = null
  let loaded = false

  function fileTarget() {
    return fsService.resolve(CACHE_FILE_NAME, cwd !== undefined ? { cwd } : {})
  }

  // The sandboxed fs backend fences every mutation with the CALLING session's
  // policy (mode + workspace root). Without one it falls back to the
  // deployment default, which does not contain the project directory, so the
  // cache file was refused and the cache never persisted. The owning
  // session's policy is the one that applies.
  function policyFor() {
    if (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function') return undefined
    const session = getSession()
    return sandboxPolicy.resolve(session ? { session } : {})
  }

  // Bound the persisted state: drop the oldest entries (smallest updatedAt)
  // until the serialized document fits into CACHE_MAX_STATE_BYTES.
  function oldestEntryIndex(entries) {
    let oldest = 0
    for (let i = 1; i < entries.length; i++) {
      const at = entries[i] && entries[i].updatedAt || 0
      const oldestAt = entries[oldest] && entries[oldest].updatedAt || 0
      if (at < oldestAt) oldest = i
    }
    return oldest
  }

  function trimState(state) {
    const entries = state && Array.isArray(state.entries) ? state.entries : []
    if (entries.length === 0) return
    // The fast pass works on the per-entry sizes (the total is an
    // over-estimate: it ignores the separating commas), so the document is
    // already inside the bound when the loop ends.
    const sizes = entries.map((e) => JSON.stringify(e).length)
    let total = JSON.stringify(state).length
    while (total > CACHE_MAX_STATE_BYTES && entries.length > 0) {
      const oldest = oldestEntryIndex(entries)
      total -= sizes[oldest]
      entries.splice(oldest, 1)
      sizes.splice(oldest, 1)
    }
    // Exact boundary: re-measure and keep trimming while the real document
    // is still too large.
    while (entries.length > 0 && JSON.stringify(state).length > CACHE_MAX_STATE_BYTES) {
      entries.splice(oldestEntryIndex(entries), 1)
    }
  }

  async function doSave() {
    if (!canWrite) return
    try {
      const state = index.exportState()
      trimState(state)
      const target = await fileTarget()
      await fsService.writeText(target, JSON.stringify(state), undefined, undefined, policyFor())
    } catch (e) { /* persistence is best-effort; the memory index stays live */ }
  }

  function flush() {
    if (!saving) saving = Promise.resolve(doSave()).finally(() => { saving = null })
    return saving
  }

  function scheduleSave() {
    if (!canWrite) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      flush()
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function load() {
    if (loaded) return
    loaded = true
    if (!canRead) return
    try {
      const target = await fileTarget()
      const text = await fsService.readText(target)
      if (typeof text === 'string') {
        index.importState(JSON.parse(text))
      }
    } catch (e) { /* no cache file yet / unreadable: start empty */ }
  }

  function upsert(rec) {
    const entry = index.upsert(rec)
    scheduleSave()
    return entry
  }

  function upsertDigest(rec) {
    const entry = index.upsertDigest(rec)
    scheduleSave()
    return entry
  }

  function invalidateByPath(path) {
    const removed = index.invalidateByPath(path)
    if (removed > 0) scheduleSave()
    return removed
  }

  function clear() {
    index.importState({ version: 1, dim: index.stats().dim, entries: [] })
    scheduleSave()
  }

  function dispose() {
    if (timer !== null) clearTimeout(timer)
    timer = null
    return flush()
  }

  /** The cached entries as plain objects (no quantized codes). */
  function list(opts) {
    return index.list(opts)
  }

  /**
   * Write a human-readable export of the cache next to the cache file.
   * Never throws: a failed export is reported as { ok: false, error }.
   * @param fileName - the file name, resolved under the cache cwd.
   * @returns { ok, path, entries } or { ok: false, error }.
   */
  async function writeExport(fileName = '.dsh-turbovec-cache.export.json') {
    if (!canWrite) return { ok: false, error: 'the cache is not writable (no fs write seam)' }
    try {
      const target = await fsService.resolve(fileName, cwd !== undefined ? { cwd } : {})
      const doc = {
        version: 2,
        project: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
        exportedAt: new Date().toISOString(),
        stats: index.stats(),
        entries: index.list({}),
      }
      const json = JSON.stringify(doc, null, 2)
      await fsService.writeText(target, json, undefined, undefined, policyFor())
      return { ok: true, path: fileName, entries: doc.entries.length }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) }
    }
  }

  /**
   * Drop the snippets whose source file no longer exists.
   * @param check - async (path) => boolean; true means the file still exists.
   * @returns { removed, checked, skipped } — never throws.
   */
  async function removeStaleFiles(check) {
    if (typeof check !== 'function') return { removed: 0, checked: 0, skipped: 0 }
    let removed = 0
    let checked = 0
    let skipped = 0
    try {
      const entries = index.list({ kind: 'snippet' })
      const seen = new Set()
      const paths = []
      for (const entry of entries) {
        const p = entry && typeof entry.path === 'string' ? entry.path : ''
        if (!p || seen.has(p)) continue
        seen.add(p)
        paths.push(p)
      }
      for (const p of paths) {
        checked++
        let exists = false
        try {
          exists = !!(await check(p))
        } catch (e) {
          skipped++
          continue
        }
        if (!exists) removed += index.invalidateByPath(p)
      }
    } catch (e) { /* a failed sweep keeps the cache as it is */ }
    if (removed > 0) scheduleSave()
    return { removed, checked, skipped }
  }

  return {
    load,
    upsert,
    upsertDigest,
    invalidateByPath,
    search: (q, o) => index.search(q, o),
    list,
    stats: () => index.stats(),
    clear,
    flush,
    dispose,
    exportState: () => index.exportState(),
    importState: (d) => index.importState(d),
    writeExport,
    removeStaleFiles,
    persistent: canWrite,
    readable: canRead,
  }
}
