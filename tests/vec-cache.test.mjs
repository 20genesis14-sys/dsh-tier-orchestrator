// Unit test for the TurboQuant cache adapter: the persistence write must carry
// the owning session's sandbox policy. The sandboxed fs backend fences every
// mutation with the CALLING session's policy; without one it fences against
// the deployment default, which does not contain the project directory, so the
// cache file was refused and the cache never persisted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVecCache, CACHE_MAX_STATE_BYTES } from '../lib/dsh/vec-cache.js'

function fakeFs() {
  const state = { written: null, policies: [] }
  return {
    state,
    async resolve(path) { return { path } },
    async readText() { throw new Error('FS_NOT_FOUND') },
    async writeText(target, content, expected, signal, policy) {
      state.written = content
      state.policies.push(policy)
    },
  }
}

const SEAMS = { fsResolve: true, fsWriteText: true, fsReadText: true }

test('the cache write carries the owning session sandbox policy', async () => {
  const fs = fakeFs()
  const requests = []
  const sandboxPolicy = {
    resolve(request) {
      requests.push(request)
      return { mode: 'workspace-write', workspaceRoot: 'D:/repo' }
    },
  }
  const session = { id: 's1', header: { cwd: 'D:/repo' } }
  const cache = createVecCache({
    fs, seams: SEAMS, cwd: 'D:/repo',
    sandboxPolicy, getSession: () => session,
  })
  cache.upsert({ id: 'a', path: 'src/a.ts', lines: '1-2', snippet: 'x' })
  await cache.flush()
  assert.ok(fs.state.written, 'the cache file was written')
  assert.equal(fs.state.policies.length, 1)
  assert.deepEqual(fs.state.policies[0], { mode: 'workspace-write', workspaceRoot: 'D:/repo' })
  assert.equal(requests[0].session, session)
})

test('without a policy service the cache write falls back to the backend default', async () => {
  const fs = fakeFs()
  const cache = createVecCache({ fs, seams: SEAMS, cwd: 'D:/repo' })
  cache.upsert({ id: 'a', path: 'src/a.ts', lines: '1-2', snippet: 'x' })
  await cache.flush()
  assert.equal(fs.state.policies.length, 1)
  assert.equal(fs.state.policies[0], undefined)
})

test('writeExport writes a human-readable document without the quantized codes', async () => {
  const fs = fakeFs()
  const cache = createVecCache({ fs, seams: SEAMS, cwd: 'D:/repo' })
  cache.upsert({ id: 'a', path: 'src/a.ts', lines: '1-2', snippet: 'export const a = 1' })
  const r = await cache.writeExport()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.path, '.dsh-turbovec-cache.export.json')
  assert.equal(r.entries, 1)
  const written = fs.state.written
  assert.ok(typeof written === 'string' && written.length > 0, 'the export file was written')
  const doc = JSON.parse(written)
  assert.equal(doc.version, 2)
  assert.equal(doc.project, 'D:/repo')
  assert.equal(typeof doc.exportedAt, 'string')
  assert.ok(doc.exportedAt.length > 0)
  assert.ok(doc.stats && typeof doc.stats.entries === 'number')
  assert.ok(Array.isArray(doc.entries))
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.entries[0].path, 'src/a.ts')
  assert.equal('codes' in doc, false, 'the export carries no quantized codes')
  assert.equal('codes' in doc.entries[0], false, 'the export entries carry no quantized codes')
})

test('removeStaleFiles drops the entries whose file is gone', async () => {
  const fs = fakeFs()
  const cache = createVecCache({ fs, seams: SEAMS, cwd: 'D:/repo' })
  cache.upsert({ id: 'a', path: 'src/gone.ts', lines: '1-2', snippet: 'x' })
  cache.upsert({ id: 'b', path: 'src/gone.ts', lines: '3-4', snippet: 'y' })
  cache.upsert({ id: 'c', path: 'src/kept.ts', lines: '1-2', snippet: 'z' })
  const r = await cache.removeStaleFiles(async (p) => p !== 'src/gone.ts')
  assert.equal(r.removed, 2)
  assert.equal(r.checked, 2)
  assert.equal(r.skipped, 0)
  assert.equal(cache.stats().snippets, 1, 'only the stale entries are gone')
})

test('the persisted state stays inside the size bound and drops the oldest entries', async () => {
  const fs = fakeFs()
  const cache = createVecCache({ fs, seams: SEAMS, cwd: 'D:/repo' })
  for (let i = 0; i < 80; i++) {
    cache.upsert({ id: 'e' + i, path: 'src/f' + i + '.ts', lines: '1-40', snippet: 'x'.repeat(4000), note: '', updatedAt: 1000 + i })
  }
  await cache.flush()
  const written = fs.state.written
  assert.ok(written.length <= CACHE_MAX_STATE_BYTES, 'the state fits into the bound: ' + written.length)
  const state = JSON.parse(written)
  assert.ok(state.entries.length < 80, 'the oldest entries were dropped: ' + state.entries.length)
  assert.ok(state.entries.some((e) => e.path === 'src/f79.ts'), 'the newest entry survives')
  assert.ok(!state.entries.some((e) => e.path === 'src/f0.ts'), 'the oldest entry is gone')
})

test('removeStaleFiles counts a throwing check as skipped and never throws', async () => {
  const fs = fakeFs()
  const cache = createVecCache({ fs, seams: SEAMS, cwd: 'D:/repo' })
  cache.upsert({ id: 'a', path: 'src/a.ts', lines: '1-2', snippet: 'x' })
  const r = await cache.removeStaleFiles(async () => { throw new Error('unreadable') })
  assert.equal(r.removed, 0)
  assert.equal(r.checked, 1)
  assert.equal(r.skipped, 1)
  assert.equal(cache.stats().snippets, 1, 'an unreadable file is never dropped')
  const none = await cache.removeStaleFiles(null)
  assert.deepEqual(none, { removed: 0, checked: 0, skipped: 0 })
})