// Tier-routing system prompt section text.
//
// Pure module: builds the lines for the `tier-routing` prompt section from a
// plain data object, so the same text is testable without a harness. In the
// `pi` prompt mode the section collapses to a few lines — details stay
// available via `/tier status` and on-demand tools instead of bloating the
// system prompt.

/**
 * Lines for the tier-routing prompt section.
 * @param {object} info - plain view of the routing state:
 *   promptMode: 'standard' | 'pi'; mode; threeTiers; planTier; strongLabel;
 *   mainLabel; cheapLabel; strongChain; mainChain; cheapChain; subagentPolicy;
 *   fallbackTtlSec; advisorMax; advisorTimeoutSec; smartActive.
 * @returns {string[]}
 */
export function tierPromptSection(info) {
  if (info && info.promptMode === 'pi') {
    return [
      '## Tiered model routing',
      'Tiers: strong = ' + info.strongLabel + '; cheap = ' + info.cheapLabel + '. Global default: ' + info.mode + '; subagent policy: ' + info.subagentPolicy + '. Heavy rules load on demand (/tier status, tier_advisor, tier_review, tier_worker).',
      'If a task needs tools outside this set (web, skills, heavy delegation), run it via `tier_worker` with `agentPreset: tiered` and use its result.',
    ]
  }
  const strong = info.strongLabel + (info.strongFollowSession ? ' (follows your session model selection)' : '')
  const main = info.mainLabel + (info.mainFollowSession ? ' (follows your session model selection)' : '')
  return [
    '## Tiered model routing',
    'This session uses tiered routing (' + (info.threeTiers ? 'three tiers' : 'two tiers') + '): strong = ' + strong + (info.threeTiers ? '; main = ' + main : '') + '; cheap = ' + info.cheapLabel + '. Fallback chains: strong -> ' + info.strongChain + '; cheap -> ' + info.cheapChain + '. Global routing default: ' + info.mode + ' (a per-session override may apply in this session); subagent policy: ' + info.subagentPolicy + '.',
    '- In auto mode, the session model follows plan state: plan mode runs on the ' + info.planTier + ' tier, execution on the cheap tier (applied per request). In delegated mode, the main agent stays on the session-selected model and only subagents are tier-routed.',
    '- A deterministic guard denies high-impact tool calls (rm -rf, sudo, force push, credential/secret file edits, ...) while the cheap tier executes: call `tier_route` with tier "strong" first, then re-issue the action.',
    '- Repeated model-step errors automatically escalate the session to the strong tier for a few minutes (failure auto-escalation; inactive in off mode).',
    '- Each tier has a fallback chain: if the primary model is unavailable (quota, rate limit, unknown model, credential or 5xx errors), the next chain entry runs the same task, then the tier returns to its primary after ' + info.fallbackTtlSec + 's. The cheap tier starts at low reasoning effort and raises itself (to medium/high/max, bounded by what the model declares) when a task proves hard; you may call "tier_escalate_effort" or /tier effort <low|medium|high|max> to set it explicitly.',
    '- Delegate bounded implementation packets to `tier_worker` (cheap tier by default; use tier "strong" for hard analysis). You may pass outputSchema for structured results, agentPreset to compose the worker from a different preset (spawn provider), maxDepth to cap delegation depth, and background to run via the jobs service.',
    '- Before committing to an approach, call `tier_advisor` when: requirements stay ambiguous after inspection; the work implicates architecture, security, authentication, data integrity, destructive migration, or compatibility and a decision is needed; several plausible root causes remain after the cheapest checks; two evidence-based attempts failed; or final validation exposes a high-cost unresolved risk. Provide ONE decision question plus the evidence already gathered.',
    '- Call `tier_review` before declaring a high-risk task complete: pass the exact change set and validation results.',
    '- In smart mode (`/tier smart`), the Main Agent plans and reviews on the ' + info.planTier + ' tier and never edits files directly: delegate exploration to `tier_sidekick` with stage "explore", code/test/lint changes to stage "implement", and bug fixes to stage "fix". Each stage runs on its configured model (cheap by default; reassign with `/tier set sidekick-<stage> <provider> <model> [effort]`).',
    '- The advisor permits ' + info.advisorMax + ' calls per user turn without asking; the next one asks for your confirmation (timeout ' + info.advisorTimeoutSec + 's) and fails closed without it.',
    '- Use `tier_route` to switch tiers for a stretch of work; use `tier_configure` to change which provider/model backs each tier; use `tier_status` to inspect routing state and seam health.',
    '- Never claim a tier or model ran unless a tool result or request header identifies it.',
  ]
}
