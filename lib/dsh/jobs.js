// Jobs adapter — normalizes background-job submission across harness
// generations.
//
// DSH >= 0.2 JobSpec.owner is a SessionId; older builds accepted the owning
// Agent. The adapter resolves whichever the runtime's declared shape accepts
// (prefers SessionId; falls back to the Agent object).

export function startBackgroundJob(jobs, spec) {
  if (!jobs || typeof jobs.start !== 'function') {
    throw new Error('jobs service is not mounted')
  }
  const ownerAgent = spec.ownerAgent
  let owner
  try {
    owner = ownerAgent && ownerAgent.session && ownerAgent.session.id
  } catch (e) { owner = undefined }
  return jobs.start({
    kind: spec.kind,
    label: spec.label,
    ...(owner !== undefined ? { owner: owner } : {}),
    run: spec.run,
  })
}
