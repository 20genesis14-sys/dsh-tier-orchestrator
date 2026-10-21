// Service probe — the single place that knows which ctx services and
// capabilities this plugin can use.
//
// Every harness-facing feature consults `seams` before registering, so a
// renamed or removed DSH API degrades one feature (with a status line the
// user can read) instead of breaking the whole plugin.

const SERVICE_NAMES = [
  'llm', 'commands', 'tools', 'planMode', 'agentDefaultModel',
  'systemPrompt', 'subagents', 'agents', 'settings', 'jobs', 'agentPresets',
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
  const seams = {
    llmStream: has(llm, 'stream'),
    llmProviders: has(llm, 'listProviders'),
    llmModels: has(llm, 'listModels'),
    llmModelInfo: has(llm, 'resolveModelInfo'),
    tools: has(services.tools, 'register'),
    commands: has(services.commands, 'register'),
    planMode: has(services.planMode, 'set'),
    defaultModel: has(services.agentDefaultModel, 'currentSelection'),
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
  }
  return { services, seams }
}

/**
 * Seams that are legitimately absent on a healthy install and must not read
 * as degradation: `subagentsLegacy`/`subagentsActivation` are alternatives
 * (one suffices), `presetRegister` is only meaningful on the host plane.
 */
export const OPTIONAL_SEAMS = ['subagentsLegacy', 'subagentsActivation', 'presetRegister']

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
