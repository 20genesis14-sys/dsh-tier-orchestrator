// Unit tests for the Pi-style minimal filesystem tools (no harness required).
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEditsToOriginal, buildReadPage, createMinimalFsTools, READ_MAX_LINES } from '../lib/minimal-fs-tools.js'

// ---- applyEditsToOriginal: Pi edit semantics ------------------------------

const SRC = 'line one\nline two\nline three'

test('single replacement', () => {
  const r = applyEditsToOriginal(SRC, [{ oldText: 'line two', newText: 'LINE TWO' }])
  assert.equal(r.content, 'line one\nLINE TWO\nline three')
  assert.equal(r.count, 1)
})

test('multiple disjoint edits all matched against the original', () => {
  const r = applyEditsToOriginal(SRC, [
    { oldText: 'line three', newText: 'LINE THREE' },
    { oldText: 'line one', newText: 'LINE ONE' },
  ])
  assert.equal(r.content, 'LINE ONE\nline two\nLINE THREE')
  assert.equal(r.count, 2)
})

test('missing oldText throws', () => {
  assert.throws(() => applyEditsToOriginal(SRC, [{ oldText: 'nope', newText: 'x' }]), /not found/)
})

test('non-unique oldText throws', () => {
  assert.throws(() => applyEditsToOriginal('a b a', [{ oldText: 'a', newText: 'x' }]), /not unique/)
})

test('overlapping edits throw', () => {
  assert.throws(
    () => applyEditsToOriginal('abcdef', [
      { oldText: 'abc', newText: 'x' },
      { oldText: 'bcd', newText: 'y' },
    ]),
    /overlap/,
  )
})

test('identical oldText twice throws (same interval overlaps itself)', () => {
  assert.throws(
    () => applyEditsToOriginal('abc', [
      { oldText: 'abc', newText: 'x' },
      { oldText: 'abc', newText: 'y' },
    ]),
    /overlap/,
  )
})

test('empty oldText throws', () => {
  assert.throws(() => applyEditsToOriginal(SRC, [{ oldText: '', newText: 'x' }]), /non-empty/)
})

test('empty edits list throws', () => {
  assert.throws(() => applyEditsToOriginal(SRC, []), /at least one replacement/)
})

// ---- buildReadPage: Pi-style pagination -----------------------------------

test('first page and continuation footer', () => {
  const text = Array.from({ length: 2500 }, (_, i) => 'line ' + (i + 1)).join('\n')
  const page = buildReadPage(text, {})
  assert.equal(page.body.split('\n').length, READ_MAX_LINES)
  assert.match(page.footer, /Use offset=2001 to continue/)
  const next = buildReadPage(text, { offset: 2001, limit: 500 })
  assert.equal(next.body.split('\n').length, 500)
  assert.match(next.footer, /End of file - total 2500 lines/)
})

test('explicit offset and limit', () => {
  const page = buildReadPage('a\nb\nc', { offset: 2, limit: 1 })
  assert.equal(page.body, 'b')
  assert.match(page.footer, /Showing lines 2-2 of 3/)
})

test('offset beyond end reports out of range', () => {
  const page = buildReadPage('a\nb\n', { offset: 10 })
  assert.match(page.footer, /beyond end of file/)
})

// ---- schemas: sparse, Pi-shaped -------------------------------------------

test('tool definitions expose minimal schemas', () => {
  const tools = createMinimalFsTools({ fs: fakeFs(), getCwd: () => undefined })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  assert.deepEqual(Object.keys(byName).sort(), ['edit', 'read', 'write'])

  const read = byName.read
  assert.deepEqual(Object.keys(read.parameters.properties).sort(), ['limit', 'offset', 'path'])
  assert.deepEqual(read.parameters.required, ['path'])
  assert.equal(read.parameters.properties.offset.required, undefined)

  const write = byName.write
  assert.deepEqual(Object.keys(write.parameters.properties).sort(), ['content', 'path'])
  assert.deepEqual(write.parameters.required, ['path', 'content'])

  const edit = byName.edit
  assert.deepEqual(Object.keys(edit.parameters.properties).sort(), ['edits', 'path'])
  assert.deepEqual(edit.parameters.required, ['path', 'edits'])
  const item = edit.parameters.properties.edits.items
  assert.deepEqual(Object.keys(item.properties).sort(), ['newText', 'oldText'])
  assert.deepEqual(item.required, ['oldText', 'newText'])
})

// ---- execution through a fake ctx.fs --------------------------------------

function fakeFs() {
  const state = { source: SRC, written: null }
  return {
    async resolve(path) { return { path } },
    async readText() { return state.source },
    async writeText(target, content) { state.written = content },
    state,
  }
}

test('read tool returns paged text', async () => {
  const fs = fakeFs()
  const [readTool] = createMinimalFsTools({ fs, getCwd: () => undefined })
  const value = await readTool.execute({ path: 'x.txt', offset: 1, limit: 2 }, { signal: undefined })
  assert.equal(value.content, 'line one\nline two\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]')
})

test('write tool writes unconditionally', async () => {
  const fs = fakeFs()
  const tools = createMinimalFsTools({ fs, getCwd: () => undefined })
  const value = await tools[1].execute({ path: 'x.txt', content: 'new' }, { signal: undefined })
  assert.equal(fs.state.written, 'new')
  assert.equal(value.content, 'Successfully wrote to x.txt')
})

test('edit tool merges multiple edits in one call', async () => {
  const fs = fakeFs()
  const tools = createMinimalFsTools({ fs, getCwd: () => undefined })
  const value = await tools[2].execute(
    { path: 'x.txt', edits: [{ oldText: 'line one', newText: 'ONE' }, { oldText: 'line three', newText: 'THREE' }] },
    { signal: undefined },
  )
  assert.equal(fs.state.written, 'ONE\nline two\nTHREE')
  assert.equal(value.content, 'Successfully replaced 2 block(s) in x.txt.')
})
