// Minimal Pi-style filesystem tools for the `tiered-minimal` preset.
//
// These tools mirror the shapes and descriptions of Pi's built-in read /
// write / edit tools, deliberately shorter than DSH's own tool schemas:
//   read  { path, offset?, limit? }
//   write { path, content }
//   edit  { path, edits: [{ oldText, newText }] }
//
// They run on the `ctx.fs` service (so sandbox-level backends keep working)
// and skip DSH's fs-observation-policy: writes and edits are unconditional,
// like Pi. Multiple edits in one call are matched against the ORIGINAL file
// content, never incrementally, exactly like Pi's edit tool.

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Default and maximum lines returned by one read call. */
export const READ_MAX_LINES = 2000

const READ_PARAMETERS = {
  path: { type: 'string', required: true, description: 'Path to the file to read (relative or absolute)' },
  offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
  limit: { type: 'number', description: 'Maximum number of lines to read' },
}

const WRITE_PARAMETERS = {
  path: { type: 'string', required: true, description: 'Path to the file to write (relative or absolute)' },
  content: { type: 'string', required: true, description: 'Content to write to the file' },
}

const EDIT_PARAMETERS = {
  path: { type: 'string', required: true, description: 'Path to the file to edit (relative or absolute)' },
  edits: {
    type: 'array',
    required: true,
    description: 'One or more targeted replacements, matched against the original file content.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        oldText: { type: 'string', required: true, description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.' },
        newText: { type: 'string', required: true, description: 'Replacement text for this targeted edit.' },
      },
    },
  },
}

/**
 * Apply a list of literal edits to the ORIGINAL content (Pi semantics):
 * every oldText must match exactly once, intervals must not overlap, and all
 * replacements are computed against the original string — never incrementally.
 * @param {string} original - original file content.
 * @param {Array<{oldText: string, newText: string}>} edits - targeted edits.
 * @returns {{content: string, count: number}} the merged content.
 * @throws {Error} with a Pi-style message on the first invalid edit.
 */
export function applyEditsToOriginal(original, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.')
  }
  const intervals = []
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    const oldText = edit && typeof edit.oldText === 'string' ? edit.oldText : ''
    const newText = edit && typeof edit.newText === 'string' ? edit.newText : ''
    if (oldText.length === 0) {
      throw new Error('Edit ' + (i + 1) + ' is invalid: oldText must be a non-empty string.')
    }
    let first = -1
    let second = -1
    let from = 0
    while (true) {
      const at = original.indexOf(oldText, from)
      if (at === -1) break
      if (first === -1) first = at
      else {
        second = at
        break
      }
      from = at + oldText.length
    }
    if (first === -1) {
      throw new Error('Edit ' + (i + 1) + ' failed: oldText was not found in the original file.')
    }
    if (second !== -1) {
      throw new Error('Edit ' + (i + 1) + ' failed: oldText is not unique in the original file (' + oldText.slice(0, 60) + ').')
    }
    intervals.push({ start: first, end: first + oldText.length, newText })
  }
  // Reject overlapping or nested edits (same interval twice is an overlap too).
  intervals.sort(function (a, b) { return a.start - b.start })
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start < intervals[i - 1].end) {
      throw new Error('Edits overlap or are nested: merge nearby changes into one edit instead.')
    }
  }
  let out = ''
  let cursor = 0
  for (const iv of intervals) {
    out += original.slice(cursor, iv.start) + iv.newText
    cursor = iv.end
  }
  out += original.slice(cursor)
  return { content: out, count: intervals.length }
}

/**
 * Build one page of line-numbered-free text (Pi-style): a plain body plus a
 * continuation footer telling the model how to keep reading.
 * @param {string} text - full file text.
 * @param {{offset?: number, limit?: number}} opts - 1-based offset and max lines.
 * @returns {{body: string, footer: string}}
 */
export function buildReadPage(text, opts = {}) {
  const allLines = text.split('\n')
  const total = allLines.length
  const startLine = Math.max(0, Math.floor(Number(opts.offset) || 1) - 1)
  const cap = Math.max(1, Math.floor(Number(opts.limit) || READ_MAX_LINES))
  const endLine = Math.min(startLine + cap, total)
  const body = allLines.slice(startLine, endLine).join('\n')
  let footer
  if (startLine >= total) {
    footer = 'Offset ' + (startLine + 1) + ' is beyond end of file (' + total + ' lines total)'
  } else if (endLine < total) {
    footer = '[Showing lines ' + (startLine + 1) + '-' + endLine + ' of ' + total + '. Use offset=' + (endLine + 1) + ' to continue.]'
  } else {
    footer = '(End of file - total ' + total + ' lines)'
  }
  return { body, footer }
}

/**
 * Register the three minimal tools on the DSH tools service.
 * @param {{fs: object, getCwd: () => string | undefined}} deps
 * @returns {Array} the registered defineTool instances (for tests).
 */
export function createMinimalFsTools({ fs, getCwd }) {
  const resolveTarget = async (path) => {
    const cwd = typeof getCwd === 'function' ? getCwd() : undefined
    return fs.resolve(path, cwd !== undefined && cwd !== null ? { cwd } : {})
  }

  const readTool = defineTool({
    name: 'read',
    description: 'Read file contents',
    parameters: READ_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
        },
      },
      render(args, value) { return [{ type: 'text', text: value.content }] },
    },
    async execute(args, exec) {
      const target = await resolveTarget(args.path)
      const text = await fs.readText(target, exec && exec.signal)
      const page = buildReadPage(text, { offset: args.offset, limit: args.limit })
      const content = page.body.length > 0 ? page.body + '\n\n' + page.footer : page.footer
      return { content }
    },
  })

  const writeTool = defineTool({
    name: 'write',
    description: 'Create or overwrite files',
    parameters: WRITE_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
        },
      },
      render(args, value) { return [{ type: 'text', text: value.content }] },
    },
    async execute(args, exec) {
      const target = await resolveTarget(args.path)
      await fs.writeText(target, args.content, undefined, exec && exec.signal)
      return { content: 'Successfully wrote to ' + args.path }
    },
  })

  const editTool = defineTool({
    name: 'edit',
    description: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
    parameters: EDIT_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
        },
      },
      render(args, value) { return [{ type: 'text', text: value.content }] },
    },
    async execute(args, exec) {
      const target = await resolveTarget(args.path)
      const original = await fs.readText(target, exec && exec.signal)
      const result = applyEditsToOriginal(original, args.edits)
      await fs.writeText(target, result.content, undefined, exec && exec.signal)
      return { content: 'Successfully replaced ' + result.count + ' block(s) in ' + args.path + '.' }
    },
  })

  return [readTool, writeTool, editTool]
}
