// TurboQuant cache adapter — persistence + bounded evidence reads on top of
// the pure `core/turbovec.js` index. This is the only place that touches the
// filesystem (`ctx.fs`), and it degrades to in-memory operation when the fs
// service or any needed method is missing.

import { createTurboQuantIndex } from '../core/turbovec.js'

export const CACHE_FILE_NAME = '.dsh-turbovec-cache.json'
export const CACHE_MAX_FILE_BYTES = 12288
export const CACHE_MAX_TOTAL_BYTES = 36864

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

  async function doSave() {
    if (!canWrite) return
    try {
      const state = index.exportState()
      const target = await fileTarget()
      await fsService.writeText(target, JSON.stringify(state))
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

  return {
    load,
    upsert,
    upsertDigest,
    invalidateByPath,
    search: (q, o) => index.search(q, o),
    stats: () => index.stats(),
    clear,
    flush,
    dispose,
    exportState: () => index.exportState(),
    importState: (d) => index.importState(d),
    persistent: canWrite,
    readable: canRead,
  }
}
