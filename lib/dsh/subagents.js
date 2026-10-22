// Subagent adapter — normalizes the runtime's delegation API across harness
// generations.
//
// Current (DSH >= 0.2): `subagents.startActivation({provider, label, request,
// signal, delivery})` returns an activation { childId, result, dispose() }.
// toolFilter/persona were removed upstream; `agentPreset` (spawn provider)
// replaces both.
//
// Legacy (DSH <= 0.1.x): `subagents.start(provider, request)` returns a run
// { localAgent, result, dispose() }.

/**
 * Start one worker subagent through whichever API the runtime exposes.
 * @param subagents - the probed `subagents` service.
 * @param spec - normalized request:
 *   { provider, label, parent, prompt (ContentBlock[]), signal, agentOptions?,
 *     outputSchema?, agentPreset? }
 * @returns { childId, localAgent?, result: Promise, dispose() } — `localAgent`
 *   exists only on the legacy path; use `agents.get(childId)` otherwise.
 */
export async function startWorker(subagents, spec) {
  if (subagents && typeof subagents.startActivation === 'function') {
    const request = {
      prompt: spec.prompt,
      parent: spec.parent,
      ...(spec.agentOptions !== undefined ? { agentOptions: spec.agentOptions } : {}),
      ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
      ...(spec.agentPreset !== undefined ? { agentPreset: spec.agentPreset } : {}),
    }
    const activation = await subagents.startActivation({
      provider: spec.provider,
      label: spec.label,
      request,
      signal: spec.signal,
      // 'caller': the tool call awaits and returns the result; nothing is
      // pushed to the parent's model context behind its back.
      delivery: 'caller',
    })
    return {
      childId: activation.childId,
      result: activation.result,
      dispose: function () { return activation.dispose() },
    }
  }
  if (subagents && typeof subagents.start === 'function') {
    const request = {
      label: spec.label,
      prompt: spec.prompt,
      parent: spec.parent,
      signal: spec.signal,
      ...(spec.agentOptions !== undefined ? { agentOptions: spec.agentOptions } : {}),
      ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
    }
    const run = await subagents.start(spec.provider, request)
    return {
      localAgent: run.localAgent,
      childId: run.localAgent && run.localAgent.session ? run.localAgent.session.id : undefined,
      result: run.result,
      dispose: function () { return run.dispose() },
    }
  }
  throw new Error('subagents service exposes no compatible start API (need startActivation or start)')
}
