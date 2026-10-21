// Portable `npm run check`: node --check every lib file without shell globs
// (cmd.exe expands nothing). Fails the run on the first syntax error.
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = []
for (const dir of ['lib', 'lib/core', 'lib/dsh']) {
  for (const f of readdirSync(join(ROOT, dir))) {
    if (f.endsWith('.js')) files.push(join(dir, f))
  }
}
for (const f of files) {
  execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'inherit' })
}
console.log('checked ' + files.length + ' files: OK')
