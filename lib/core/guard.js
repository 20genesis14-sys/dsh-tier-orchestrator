// High-impact action detection — pure logic, no harness imports, no I/O.
//
// The guard must be deterministic: while a lower tier executes, dangerous
// tool calls are denied by pattern, never by model self-discipline.

/**
 * Command runners that can prefix `rm` and still execute it. Two groups:
 * `ARG_RUNNERS` legitimately carry their own arguments before the command
 * (`env -i rm -rf`, `timeout 5 rm -rf`, `xargs -0 rm -rf`), so they allow
 * any arguments before `rm`; `DIRECT_RUNNERS` take the command immediately
 * (`nohup rm -rf`), so allowing arguments there would false-positive on
 * harmless forms like `nohup echo rm -rf`.
 */
const ARG_RUNNERS = 'sudo|env|timeout|nice|xargs|doas|setarch|stdbuf|ionice'
const DIRECT_RUNNERS = 'command|exec|busybox|nohup|pkexec'

/**
 * Detect `rm` with BOTH recursive (`-r`/`-R`/`--recursive`) and force (`-f`/
 * `--force`) flags, allowing split flags like `rm -r -f` that a single-token
 * regex misses. Anchored to command position so prose like "echo rm -rf"
 * does not match. Runner arguments (`env -i rm -rf`) and a backslash escape
 * (`\rm -rf`) still execute rm.
 */
export function hasRecursiveForceRm(cmd) {
  if (typeof cmd !== 'string') return false
  // rm at command position: start of string, after a separator, or after a
  // known command runner (with optional runner arguments where the runner
  // can carry them).
  const sep = cmd.match(new RegExp(
    '(^|[;&|]\\s*' +
    '|\\b(' + ARG_RUNNERS + ')\\s+(?:\\S+\\s+)*' +
    '|\\b(' + DIRECT_RUNNERS + ')\\s+' +
    ')\\\\?rm(\\s+)',
    'i'
  ))
  if (!sep) return false
  const rest = cmd.slice(sep.index + sep[0].length)
  let flags = ''
  for (const token of rest.split(/\s+/)) {
    if (/^--?[a-zA-Z]/.test(token)) flags += token.replace(/^-+/, '')
    else break
  }
  flags = flags.toLowerCase()
  return flags.includes('r') && flags.includes('f')
}

/** Conservative high-impact command patterns (checked after the rm rule). */
export const HIGH_IMPACT_COMMAND = [
  /\bmkfs\.?[a-z]*\b/,
  /\bdd\s+(if|of)=/,
  /(^|[;&|]\s*)sudo\b/,
  /(^|[;&|]\s*)(shutdown|reboot|halt)\b/,
  /git\s+push\s+[^\n]*(-f\b|--force)/,
  /git\s+clean\s+(-[a-z]*f[a-z]*\b)/,
  /find\s+[^\n]*\s+-delete\b/,
  /find\s+[^\n]*-exec\s+[^\n]*\brm\b/,
  /\b(shutil\.rmtree|rmtree)\s*\(/,
  /\bos\.remove\s*\(/,
  /python[0-9.]*\s+-c\s+[^|;&\n]*(rmtree|os\.remove|shutil\.rmtree|rm\s+-rf)/,
  /curl\s+[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /wget\s+[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /\bchmod\s+[0-7]{3,4}\s+[^\n]*\.ssh\//,
  /\bchown\s/,
  /\bdiskutil\s+(eraseDisk|eraseVolume|zeroDisk|secureErase|unmountDisk)\b/,
]

/**
 * Conservative high-impact file-path patterns (credentials, keys, secrets).
 * `.env` matches unless the suffix is an example/sample/template name.
 */
export const HIGH_IMPACT_PATH = [
  /(^|\/)\.env(\.(?!example|sample|template)[^/]*)?$/i,
  /(^|\/)(credentials?|secrets?)(\.(json|ya?ml|toml|ini|env|key|pem|txt))?($|\/)/i,
  /(^|\/)\.ssh\//,
  /(^|\/)(id_(rsa|ed25519|ecdsa|dsa)|\.netrc)(\b|\/)/i,
  /\.(pem|key|p12|pfx|jks)$/i,
]

/**
 * Match a tool call against the high-impact patterns.
 * @param name - the tool name ('bash', 'write', 'edit', ...).
 * @param args - the parsed tool arguments.
 * @returns a human-readable match description, or null when the call is not high-impact.
 */
/** Shell tool names the preset may mount (bash is Linux/macOS, pwsh Windows). */
const SHELL_TOOLS = ['bash', 'pwsh', 'powershell', 'shell']
/** Argument fields that may carry the command line across host versions. */
const COMMAND_FIELDS = ['command', 'cmd', 'script']
/** File-mutating tool names. */
const FILE_TOOLS = ['write', 'edit', 'create', 'str_replace']
/** Argument fields that may carry the target path across host versions. */
const PATH_FIELDS = ['file_path', 'path', 'filePath']

function firstString(args, fields) {
  for (const f of fields) {
    if (typeof args[f] === 'string' && args[f].length > 0) return args[f]
  }
  return null
}

export function isHighImpact(name, args) {
  if (!args || typeof args !== 'object') return null
  if (SHELL_TOOLS.indexOf(name) !== -1) {
    const command = firstString(args, COMMAND_FIELDS)
    if (command !== null) {
      if (hasRecursiveForceRm(command)) {
        return 'command pattern rm -r/-f matched (recursive force delete)'
      }

      for (const re of HIGH_IMPACT_COMMAND) {
        const m = String(command).match(re)
        if (m) return 'command pattern /' + re.source + '/ matched: "' + String(m[0]).trim().slice(0, 80) + '"'
      }
    }
  }
  if (FILE_TOOLS.indexOf(name) !== -1) {
    const filePath = firstString(args, PATH_FIELDS)
    if (filePath !== null) {
      for (const re of HIGH_IMPACT_PATH) {
        if (re.test(filePath)) return 'file path pattern /' + re.source + '/ matched: "' + filePath.slice(0, 120) + '"'
      }
    }
  }
  return null
}
