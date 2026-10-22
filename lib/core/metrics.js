// Diagnostic counters — pure data.
//
// One counters object per mounted instance; every listener/tool bumps fields.
// Kept separate so future telemetry (a real event stream, per-tier stats for
// "model X could not handle task Y" analysis) has a single funnel to grow.

export function createDiag() {
  return {
    requestSteps: 0,
    guardChecks: 0,
    guardDenies: 0,
    headerWrites: 0,
    inboxSeen: 0,
    planFlips: 0,
    errorsSeen: 0,
    escalations: 0,
    fallbacks: 0,
    effortRaises: 0,
    planGateDenies: 0,
    planConsults: 0,
    advisorBudgetDenies: 0,
    decisionCalls: 0,
    decisionHits: 0,
    decisionErrors: 0,
    decisionBudgetDenies: 0,
    decisionSkips: 0,
    sidekickCalls: 0,
    digestHits: 0,
    recallCalls: 0,
    lastGate: '',
    lastRouting: '',
    lastGuard: '',
    lastGuardError: '',
    lastHeader: '',
    lastError: '',
    lastEscalation: '',
    lastFallback: '',
    lastEffort: '',
    lastDecision: ''
  }
}
