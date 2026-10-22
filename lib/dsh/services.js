// Service probe — the single place that knows which ctx services and
// capabilities this plugin can use.
//
// Every harness-facing feature consults `seams` before registering, so a
// renamed or removed DSH API degrades one feature (with a status line the
// user can read) instead of breaking the whole plugin.

const SERVICE_NAMES = [
  'llm', 'commands', 'tools', 'planMode', 'agentDefaultModel',
  'systemPrompt', 'subagents', 'agents', 'settings', 'jobs', 'agentPresets',
  'approval', 'fs', 'sandboxPolicy',
]

function tryGet(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch (e) {}
  try { return ctx[name] } catch (e) { return undefined }
}

function has(obj, method) {
  return !!obj && typeof obj[method] === 'function'
}

/**
 * Collect every service this plugin may consume and probe the exact methods
 * each feature needs. Missing services are `undefined`, never throws.
 * @returns { services, seams } — `seams` is a flat capability map for
 *   feature-gating and diagnostics (`/tier status` prints it).
 */
export function probeServices(ctx) {
  const services = {}
  for (const name of SERVICE_NAMES) services[name] = tryGet(ctx, name)
  const llm = services.llm
  const subagents = services.subagents
  const jobs = services.jobs
  const settings = services.settings
  const fsService = services.fs
  const approval = services.approval
  const seams = {
    llmStream: has(llm, 'stream'),
    llmProviders: has(llm, 'listProviders'),
    llmModels: has(llm, 'listModels'),
    llmModelInfo: has(llm, 'resolveModelInfo'),
    tools: has(services.tools, 'register'),
    commands: has(services.commands, 'register'),
    planMode: has(services.planMode, 'set'),
    // Read by persist-only paths: the session picker is never consulted for
    // routing (v0.10.1), so only the write half is probed. A probed-but-unread
    // seam would report a false "missing:" entry in /tier status.
    defaultModelSave: has(services.agentDefaultModel, 'saveSelection'),
    systemPrompt: has(services.systemPrompt, 'section'),
    subagentsActivation: has(subagents, 'startActivation'),
    subagentsLegacy: has(subagents, 'start'),
    subagentsList: has(subagents, 'list'),
    agentsGet: has(services.agents, 'get'),
    settingsRead: has(settings, 'describe'),
    settingsWrite: has(settings, 'update'),
    jobsStart: has(jobs, 'start'),
    jobsController: has(jobs, 'attachController'),
    presetRegister: has(services.agentPresets, 'register'),
    events: typeof ctx.on === 'function',
    // Smart-mode & advisor-budget seams: approval requests (the ask dialog for
    // the advisor per-turn budget) and the filesystem service (TurboQuant
    // cache persistence + paths[] evidence reads).
    approvalRequest: has(approval, 'request'),
    fsResolve: has(fsService, 'resolve'),
    fsReadText: has(fsService, 'readText'),
    fsWriteText: has(fsService, 'writeText'),
    fsEditText: has(fsService, 'editText'),
    fsStat: has(fsService, 'stat'),
    // The sandbox policy service: the sandboxed fs backend fences every
    // mutation with the CALLING session's resolved policy (mode + workspace
    // root). A caller that omits it falls back to the deployment default.
    sandboxPolicy: has(services.sandboxPolicy, 'resolve'),
  }
  return { services, seams }
}

/**
 * Seams that are legitimately absent on a healthy install and must not read
 * as degradation: `subagentsLegacy`/`subagentsActivation` are alternatives
 * (one suffices), `presetRegister` is only meaningful on the host plane,
 * `approvalRequest`/`fs*` gate optional features (advisor budget dialog,
 * TurboQuant cache persistence) that degrade softly when missing.
 */
export const OPTIONAL_SEAMS = [
  'subagentsLegacy', 'subagentsActivation', 'presetRegister',
  'approvalRequest', 'fsResolve', 'fsReadText', 'fsWriteText', 'fsEditText',
  'fsStat',
  'sandboxPolicy',
]

/** One-line seam report for status output: `ok` / `missing:name` entries. */
export function seamReport(seams) {
  const missing = Object.keys(seams).filter(function (k) {
    return !seams[k] && OPTIONAL_SEAMS.indexOf(k) === -1
  })
  // Subagents are required overall: flag when NEITHER API generation exists.
  if (!seams.subagentsActivation && !seams.subagentsLegacy) missing.push('subagents')
  return missing.length === 0
    ? 'all ok'
    : 'missing: ' + missing.join(', ')
}
