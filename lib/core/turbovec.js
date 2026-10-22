// Local code vectorizer + 4-bit TurboQuant index — pure logic, no harness
// imports, no I/O, no Node globals (base64 is hand-rolled so this module
// stays portable).
//
// What it does:
//   1. embedCodeText(text, dim) — a fully local, deterministic bag-of-tokens
//      embedding (d = 512) built from file paths/extensions, identifiers
//      (camel/snake/kebab), symbol trigrams, code keywords and adjacent-word
//      pairs, accumulated with Signed Feature Hashing and L2-normalized.
//   2. rotateVector(vec, dim) — a deterministic orthogonal rotation (sign
//      scrambling + Fast Walsh–Hadamard Transform) that spreads the sparse
//      embedding coordinates into a standard-normal-like distribution without
//      storing a dim×dim matrix. Dot products survive up to the known H scale
//      factor (n), which search divides out again.
//   3. createTurboQuantIndex() — a 4-bit index: each vector is quantized to
//      16 Lloyd–Max levels of the standard normal, two coordinates per byte
//      (256 bytes per vector at d = 512), with LUT-based inner products,
//      path invalidation, and base64 state export/import.
//
// Honest limitation: retrieval quality is a heuristic (pure hashing); it is
// meant to surface *likely relevant* snippets between subagent calls, not to
// be an exact code search.

const DEFAULT_DIM = 512
const DEFAULT_MAX_ENTRIES = 2000
/** Digest cards kept per stage (oldest evicted first). Documented as 16. */
export const DIGEST_MAX_PER_STAGE = 16

// ---- deterministic hashing ------------------------------------------------

function fnv1a(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Split one identifier into lowercase word parts (camel/Pascal/snake/kebab). */
function identifierWords(id) {
  const spaced = String(id)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
  const words = []
  for (const raw of spaced.split(' ')) {
    const w = raw.trim().toLowerCase()
    if (w.length >= 2 && !STOPWORDS.has(w)) words.push(w)
  }
  return words
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can',
  'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him',
  'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who',
  'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'may',
  'off', 'etc', 'via', 'per', 'own', 'men', 'own',
])

const CODE_KEYWORDS = new Set([
  'function', 'class', 'const', 'let', 'var', 'return', 'if', 'else',
  'for', 'while', 'import', 'export', 'from', 'default', 'async', 'await',
  'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'extends',
  'implements', 'interface', 'type', 'enum', 'struct', 'impl', 'fn', 'pub',
  'use', 'module', 'package', 'def', 'public', 'private', 'protected',
  'static', 'void', 'null', 'undefined', 'true', 'false', 'switch', 'case',
  'break', 'continue', 'do', 'yield', 'get', 'set', 'test', 'describe',
  'it', 'assert', 'expect', 'beforeEach', 'afterEach', 'mock', 'spy',
  'stub', 'config', 'args', 'params', 'value', 'values', 'key', 'keys',
  'items', 'list', 'map', 'filter', 'reduce', 'push', 'pop', 'slice',
  'splice', 'join', 'trim', 'length', 'error', 'errors', 'fail', 'failed',
  'success', 'ok', 'status', 'response', 'request', 'server', 'client',
  'data', 'file', 'files', 'path', 'dir', 'dirs', 'line', 'lines',
])

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g
// Candidates only: a path-like run of characters, verified against
// PATH_TAIL_RE in code. Two greedy overlapping classes in one pattern
// backtrack quadratically on long dotless runs (a 4000-char identifier
// stalled the embedder for seconds per token).
const PATH_RE = /[\w.\-/\\]{2,}/g
const PATH_TAIL_RE = /[\w-]+\.[A-Za-z0-9_]{1,12}$/

const MAX_TOKEN_EVENTS = 20000
const MAX_DISTINCT_TOKENS = 12000

/**
 * Local code embedding: a sparse signed-hash bag over extracted tokens.
 * @param text - any code or query text.
 * @param dim  - embedding dimension (default 512).
 * @returns Float32Array(dim), L2-normalized (zero vector when no tokens).
 */
export function embedCodeText(text, dim = DEFAULT_DIM) {
  const src = String(text ?? '')
  const counts = new Map() // token -> { count, base }
  let events = 0

  const add = (token, base) => {
    if (events >= MAX_TOKEN_EVENTS || counts.size >= MAX_DISTINCT_TOKENS) return
    events++
    const rec = counts.get(token)
    if (rec) {
      rec.count++
      if (base > rec.base) rec.base = base
    } else {
      counts.set(token, { count: 1, base })
    }
  }

  // Paths + extensions.
  let m
  const pathRe = new RegExp(PATH_RE.source, 'g')
  while ((m = pathRe.exec(src)) !== null) {
    const run = m[0]
    // The path token ends at the last "name.ext" the run contains: prefer
    // the whole run, otherwise keep the prefix through the first ".ext"
    // (a run without a dot can never match, which is what made the old
    // single-pattern scan quadratic).
    let p = null
    if (PATH_TAIL_RE.test(run)) p = run
    else if (run.indexOf('.') !== -1) {
      const inner = /[\w-]+\.[A-Za-z0-9_]{1,12}/.exec(run)
      if (inner) p = run.slice(0, inner.index + inner[0].length)
    }
    if (p === null) continue
    add('path:' + p.toLowerCase(), 3)
    const dot = p.lastIndexOf('.')
    if (dot !== -1 && dot < p.length - 1) add('ext:' + p.slice(dot + 1).toLowerCase(), 2)
  }

  // Identifiers (words, symbols, trigrams, keywords) + adjacency pairs.
  const idRe = new RegExp(IDENT_RE.source, 'g')
  const lineWords = new Map() // line index -> words[]
  let lineNo = 0
  let lastNewline = -1
  while ((m = idRe.exec(src)) !== null) {
    const raw = m[0]
    if (raw.length > 100) continue
    const lower = raw.toLowerCase()
    add('id:' + lower, 1)
    for (const w of identifierWords(raw)) add('w:' + w, 1)
    if (/^[A-Z][A-Z0-9_]*$/.test(raw) || /^[A-Z][a-z]+Error$/.test(raw)) add('sym:' + lower, 2)
    if (CODE_KEYWORDS.has(lower)) add('kw:' + lower, 2.5)
    if (raw.length >= 3) {
      for (let i = 0; i + 3 <= raw.length; i++) add('t:' + lower.slice(i, i + 3), 0.6)
    }
    // track line words for pairs
    const nl = src.lastIndexOf('\n', m.index)
    if (nl > lastNewline) { lastNewline = nl; lineNo++ }
    const arr = lineWords.get(lineNo) || []
    arr.push(lower)
    lineWords.set(lineNo, arr)
  }
  for (const arr of lineWords.values()) {
    for (let i = 0; i + 1 < arr.length; i++) {
      add('p:' + arr[i] + '_' + arr[i + 1], 1.2)
    }
  }

  const vector = new Float32Array(dim)
  for (const [token, rec] of counts) {
    const h1 = fnv1a(token, 0x811c9dc5)
    const idx = h1 % dim
    const h2 = fnv1a(token, 0x9e3779b9)
    const sign = (h2 & 1) ? 1 : -1
    const weight = rec.base * (1 + Math.log1p(rec.count))
    vector[idx] += sign * weight
  }

  // L2 normalize.
  let sum = 0
  for (let i = 0; i < dim; i++) sum += vector[i] * vector[i]
  if (sum > 0) {
    const inv = 1 / Math.sqrt(sum)
    for (let i = 0; i < dim; i++) vector[i] *= inv
  }
  return vector
}

// ---- orthogonal rotation (sign scramble + FWHT) ----------------------------

function fwht(a) {
  const n = a.length
  for (let len = 1; len < n; len <<= 1) {
    for (let i = 0; i < n; i += len << 1) {
      for (let j = i; j < i + len; j++) {
        const u = a[j]
        const v = a[j + len]
        a[j] = u + v
        a[j + len] = u - v
      }
    }
  }
}

/**
 * Deterministic orthogonal rotation for dim = power of two. Sign scrambling
 * then FWHT (unnormalized) maps a unit-norm sparse vector onto coordinates
 * that are standard-normal-ish; the transform scales inner products by n,
 * which search divides out.
 * @param vec - Float32Array/Float64Array of length dim.
 * @param dim - power of two (default 512).
 * @returns Float64Array(dim).
 */
export function rotateVector(vec, dim = DEFAULT_DIM) {
  const out = new Float64Array(dim)
  for (let i = 0; i < dim; i++) {
    const s = (fnv1a('rot:' + i, 0x1234abcd) & 1) ? 1 : -1
    out[i] = s * (vec[i] || 0)
  }
  fwht(out)
  return out
}

// ---- standard-normal quantiles (Acklam), Lloyd–Max levels ------------------

function normInv(p) {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const plow = 0.02425
  let q
  let r
  let x
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p > 1 - plow) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else {
    q = p - 0.5
    r = q * q
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  return x
}

/** 16 Lloyd–Max reconstruction levels of the standard normal. */
export const TURBO_LEVELS = (() => {
  const levels = new Float64Array(16)
  for (let i = 0; i < 16; i++) levels[i] = normInv((i + 0.5) / 16)
  return levels
})()

const TURBO_THRESHOLDS = (() => {
  const t = new Float64Array(15)
  for (let i = 0; i < 15; i++) t[i] = (TURBO_LEVELS[i] + TURBO_LEVELS[i + 1]) / 2
  return t
})()

function quantizeCoordinate(x) {
  for (let j = 0; j < 15; j++) {
    if (x < TURBO_THRESHOLDS[j]) return j
  }
  return 15
}

// ---- hand-rolled base64 (no Buffer, keeps core portable) ------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (b0 << 16) | (b1 << 8) | b2
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

function base64ToBytes(text) {
  let clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '')
  while (clean.length % 4 !== 0) clean += '='
  let pad = 0
  if (clean.endsWith('==')) pad = 2
  else if (clean.endsWith('=')) pad = 1
  const outLen = (clean.length / 4) * 3 - pad
  const out = new Uint8Array(outLen)
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i])
    const c1 = B64.indexOf(clean[i + 1])
    const c2 = clean[i + 2] === '=' ? 0 : B64.indexOf(clean[i + 2])
    const c3 = clean[i + 3] === '=' ? 0 : B64.indexOf(clean[i + 3])
    if (p < outLen) out[p++] = (c0 << 2) | (c1 >> 4)
    if (p < outLen) out[p++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (p < outLen) out[p++] = ((c2 & 3) << 6) | c3
  }
  return out
}

// ---- the TurboQuant index --------------------------------------------------

/**
 * 4-bit TurboQuant index over the local embedding.
 * @param options - { dim = 512, maxEntries = 2000 }.
 */
export function createTurboQuantIndex(options = {}) {
  const dim = options.dim ?? DEFAULT_DIM
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const half = dim >> 1
  if ((dim & (dim - 1)) !== 0 || dim < 16) throw new Error('turbovec: dim must be a power of two >= 16')

  const index = new Map() // key -> entry

  function rotate(vec) { return rotateVector(vec, dim) }
  function embed(text) { return embedCodeText(text, dim) }

  /**
   * Stage matching shared by search() and list(): a falsy filter matches
   * everything, a string matches that exact stage, an array matches any of
   * its stages.
   */
  function stageMatches(entry, stageFilter) {
    if (!stageFilter) return true
    if (Array.isArray(stageFilter)) return stageFilter.some((s) => s === entry.stage)
    return entry.stage === stageFilter
  }

  function encodeEntry(entry) {
    const codes = new Uint8Array(half)
    const v = rotate(embed(entry.path + '\n' + (entry.note || '') + '\n' + (entry.snippet || '')))
    for (let i = 0; i < dim; i++) {
      const c = quantizeCoordinate(v[i])
      if ((i & 1) === 0) codes[i >> 1] = c << 4
      else codes[i >> 1] |= c
    }
    let sum = 0
    for (let i = 0; i < half; i++) {
      const hi = codes[i] >> 4
      const lo = codes[i] & 15
      const a = TURBO_LEVELS[hi]
      const b = TURBO_LEVELS[lo]
      sum += a * a + b * b
    }
    entry.codes = codes
    entry.norm = Math.sqrt(sum)
    return entry
  }

  function evictOne() {
    let oldestKey = null
    let oldestAt = Infinity
    for (const [key, entry] of index) {
      const at = entry.updatedAt || 0
      if (at < oldestAt) { oldestAt = at; oldestKey = key }
    }
    if (oldestKey !== null) index.delete(oldestKey)
  }

  /**
   * Insert or refresh one snippet. Free-text metadata is truncated so the
   * exported cache file stays bounded regardless of source text size.
   * @param rec - { id, path, lines, snippet, note?, stage?, updatedAt? }.
   * @returns the stored entry.
   */
  function upsert(rec) {
    if (!rec || typeof rec.path !== 'string' || rec.path.length === 0) return null
    const normalized = {
      ...rec,
      kind: rec.kind === 'digest' ? 'digest' : 'snippet',
      path: rec.path.slice(0, 500),
      lines: String(rec.lines ?? '').slice(0, 80),
      snippet: String(rec.snippet ?? '').slice(0, 4000),
      note: String(rec.note ?? '').slice(0, 1000),
    }
    const key = normalized.path + '::' + normalized.lines
    const existing = index.get(key)
    if (existing) {
      Object.assign(existing, normalized)
      existing.key = key
      existing.updatedAt = normalized.updatedAt ?? Date.now()
      encodeEntry(existing)
      return existing
    }
    const entry = { ...normalized, key, updatedAt: normalized.updatedAt ?? Date.now() }
    encodeEntry(entry)
    if (index.size >= maxEntries) evictOne()
    index.set(key, entry)
    return entry
  }

  /**
   * Insert or refresh a digest card: the compact memory of a completed
   * sidekick stage for an area (module/dir/topic). Cards are searched by the
   * same embedding (the encoded area + summary text), are listed per stage,
   * and are capped per stage (oldest first eviction). They are never removed
   * by file invalidation: a card describes a result, not a file.
   * @param rec - { stage, area, diffSummary, checks?, issues?, updatedAt? }.
   * @returns the stored entry, or null on invalid input.
   */
  function upsertDigest(rec) {
    if (!rec || typeof rec.stage !== 'string' || rec.stage.length === 0) return null
    const stage = rec.stage
    const area = String(rec.area ?? '').trim().toLowerCase().slice(0, 200)
    if (!area) return null
    const snippet = String(rec.diffSummary ?? '').slice(0, 4000)
    const note = String([rec.checks, rec.issues].filter((x) => typeof x === 'string' && x.length > 0).join('\n')).slice(0, 1000)
    const key = 'digest::' + stage + '::' + area
    const existing = index.get(key)
    if (existing) {
      Object.assign(existing, {
        kind: 'digest',
        path: area,
        lines: '',
        snippet,
        note,
        stage,
        updatedAt: rec.updatedAt ?? Date.now(),
      })
      encodeEntry(existing)
      return existing
    }
    const entry = {
      kind: 'digest',
      id: rec.id ?? ('digest:' + stage + ':' + area),
      path: area,
      lines: '',
      snippet,
      note,
      stage,
      updatedAt: rec.updatedAt ?? Date.now(),
      key,
    }
    encodeEntry(entry)
    // Per-stage cap: drop the oldest digest of this stage.
    const stageEntries = []
    for (const e of index.values()) {
      if (e.kind === 'digest' && e.stage === stage) stageEntries.push(e)
    }
    while (stageEntries.length >= DIGEST_MAX_PER_STAGE) {
      let oldest = null
      for (const e of stageEntries) {
        if (!oldest || e.updatedAt < oldest.updatedAt) oldest = e
      }
      if (!oldest) break
      index.delete(oldest.key)
      stageEntries.splice(stageEntries.indexOf(oldest), 1)
    }
    index.set(key, entry)
    return entry
  }

  /** Remove every snippet of one file (cache invalidation on rewrite). Digest cards are never removed here. */
  function invalidateByPath(path) {
    let removed = 0
    for (const [key, entry] of index) {
      if (entry.kind === 'digest') continue
      if (entry.path === path || entry.path.startsWith(path + '/')) {
        index.delete(key)
        removed++
      }
    }
    return removed
  }

  /**
   * Top-k search over snippets and digest cards. Query text is embedded and
   * rotated the same way the index was built; the score is the cosine between
   * the rotated query and the dequantized stored vector. Results are sorted
   * deterministically: score desc, then path+lines asc (stable prefix for
   * prompt assembly).
   * @param queryText - free text to match.
   * @param opts - { k = 5, minScore = 0.18, pathFilter? (string | string[]),
   *   kindFilter? ('snippet' | 'digest'), stageFilter? (string | string[]) }.
   * @returns entries sorted by score desc, each with `score` and `kind`.
   */
  function search(queryText, opts = {}) {
    const k = opts.k ?? 5
    const minScore = opts.minScore ?? 0.18
    const pathFilter = opts.pathFilter
    const kindFilter = opts.kindFilter
    const stageFilter = opts.stageFilter
    const pathMatches = (path) => {
      if (!pathFilter) return true
      const roots = Array.isArray(pathFilter) ? pathFilter : [pathFilter]
      return roots.some((root) => root && (path === root || path.startsWith(root + '/')))
    }
    const q = rotate(embed(String(queryText)))
    const results = []
    const normQ = Math.sqrt(dim)
    for (const entry of index.values()) {
      if (!pathMatches(entry.path)) continue
      if (kindFilter && entry.kind !== kindFilter) continue
      if (!stageMatches(entry, stageFilter)) continue
      let dot = 0
      const codes = entry.codes
      for (let i = 0; i < half; i++) {
        // byte i holds coordinate 2i (high nibble) and 2i+1 (low nibble)
        const hi = codes[i] >> 4
        const lo = codes[i] & 15
        dot += q[i << 1] * TURBO_LEVELS[hi] + q[(i << 1) | 1] * TURBO_LEVELS[lo]
      }
      const denom = normQ * entry.norm
      const score = denom > 0 ? dot / denom : 0
      if (score >= minScore) {
        results.push({
          kind: entry.kind === 'digest' ? 'digest' : 'snippet',
          id: entry.id,
          path: entry.path,
          lines: entry.lines,
          snippet: entry.snippet,
          note: entry.note,
          stage: entry.stage,
          updatedAt: entry.updatedAt,
          score,
        })
      }
    }
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ka = a.path + '::' + a.lines
      const kb = b.path + '::' + b.lines
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    return results.slice(0, k)
  }

  /**
   * List the cached entries as plain objects (no quantized codes). The same
   * matching semantics as search(): `kind` selects snippets or digest cards,
   * `stage` accepts one stage or a list of stages. The result is sorted
   * deterministically by (path, lines, stage).
   * @param opts - { kind?: 'snippet' | 'digest', stage?: string | string[] }.
   * @returns [{ kind, id, path, lines, snippet, note, stage, updatedAt }].
   */
  function list(opts = {}) {
    const kindFilter = opts.kind
    const stageFilter = opts.stage
    const out = []
    for (const entry of index.values()) {
      const kind = entry.kind === 'digest' ? 'digest' : 'snippet'
      if (kindFilter && kind !== kindFilter) continue
      if (!stageMatches(entry, stageFilter)) continue
      out.push({
        kind,
        id: entry.id,
        path: entry.path,
        lines: entry.lines,
        snippet: entry.snippet,
        note: entry.note,
        stage: entry.stage,
        updatedAt: entry.updatedAt,
      })
    }
    out.sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1
      if (a.lines !== b.lines) return a.lines < b.lines ? -1 : 1
      const sa = String(a.stage ?? '')
      const sb = String(b.stage ?? '')
      if (sa !== sb) return sa < sb ? -1 : 1
      return 0
    })
    return out
  }

  let importSkipped = 0

  /** Index statistics for /tier cache status. */
  function stats() {
    let snippets = 0
    let digests = 0
    // Digest cards per stage. The four known stages are always present
    // (0 when absent); any other stage is added on first use.
    const stages = { explore: 0, implement: 0, fix: 0, worker: 0 }
    for (const entry of index.values()) {
      if (entry.kind === 'digest') {
        digests++
        const stage = entry.stage
        if (typeof stage === 'string' && stage.length > 0) {
          if (stages[stage] === undefined) stages[stage] = 0
          stages[stage] = stages[stage] + 1
        }
      } else {
        snippets++
      }
    }
    return {
      dim,
      maxEntries,
      entries: index.size,
      bytes: index.size * half,
      half,
      snippets,
      digests,
      stages,
      importSkipped,
    }
  }

  function exportState() {
    const entries = []
    for (const entry of index.values()) {
      entries.push({
        kind: entry.kind === 'digest' ? 'digest' : 'snippet',
        id: entry.id,
        path: entry.path,
        lines: entry.lines,
        snippet: entry.snippet,
        note: entry.note,
        stage: entry.stage,
        updatedAt: entry.updatedAt,
        codes: bytesToBase64(entry.codes),
        norm: entry.norm,
      })
    }
    return { version: 2, dim, maxEntries, entries }
  }

  function importState(data) {
    if (!data || (data.version !== 1 && data.version !== 2) || data.dim !== dim) return false
    index.clear()
    for (const raw of Array.isArray(data.entries) ? data.entries : []) {
      if (!raw || typeof raw.path !== 'string') {
        importSkipped++
        continue
      }
      let codes
      try {
        codes = base64ToBytes(raw.codes || '')
      } catch (e) {
        importSkipped++
        continue
      }
      if (codes.length !== half) {
        importSkipped++
        continue
      }
      const kind = raw.kind === 'digest' ? 'digest' : 'snippet'
      const key = kind === 'digest'
        ? 'digest::' + String(raw.stage ?? '') + '::' + raw.path
        : raw.path + '::' + String(raw.lines ?? '')
      index.set(key, {
        kind,
        id: raw.id,
        path: raw.path,
        lines: raw.lines,
        snippet: raw.snippet,
        note: raw.note,
        stage: raw.stage,
        updatedAt: raw.updatedAt ?? 0,
        codes,
        norm: typeof raw.norm === 'number' && raw.norm > 0 ? raw.norm : Math.sqrt(half),
      })
    }
    return true
  }

  return { upsert, upsertDigest, invalidateByPath, search, stats, exportState, importState, list }
}
