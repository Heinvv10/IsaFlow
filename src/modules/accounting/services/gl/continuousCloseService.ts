/**
 * Continuous Close Service — Background close agent that auto-processes accounting data.
 * Pure business logic — no database dependencies.
 */

export interface CloseState {
  uncategorizedTxCount: number;
  unmatchedTxCount: number;
  pendingInvoiceCount: number;
  pendingJournalCount: number;
  uncategorizedTransactions: Array<{ id: string; description: string; amount: number }>;
  unmatchedTransactions: Array<{ id: string; amount: number; reference: string }>;
  pendingInvoices: Array<{ id: string; amount: number; confidence: number }>;
  pendingJournals: Array<{ id: string; status: string }>;
}

export interface CloseActionPlan {
  step1_categorize: string[];
  step2_match: string[];
  step3_approve: string[];
  step4_post: string[];
  step5_exceptions: CloseException[];
}

export interface CloseRunResults {
  categorized: number;
  matched: number;
  approved: number;
  posted: number;
  exceptions: CloseException[];
}

export interface CloseRunSummary {
  totalActions: number;
  successful: number;
  failed: number;
  exceptions: number;
  duration: number;
  timestamp: string;
}

export interface CloseException {
  type: 'low_confidence' | 'amount_threshold' | 'missing_data' | 'rule_violation';
  entityId: string;
  entityType: string;
  reason: string;
  severity: 'high' | 'medium' | 'low';
}

interface CategorizationSuggestion {
  confidence: number;
  source: string;
}

interface MatchCandidate {
  confidence: number;
}

const AUTO_APPROVE_THRESHOLD = 50000;
const MIN_CATEGORIZE_CONFIDENCE = 0.8;
const MIN_MATCH_CONFIDENCE = 0.7;
const MIN_APPROVE_CONFIDENCE = 0.85;

export function planCloseActions(state: CloseState): CloseActionPlan {
  const plan: CloseActionPlan = {
    step1_categorize: state.uncategorizedTransactions.map(tx => tx.id),
    step2_match: state.unmatchedTransactions.map(tx => tx.id),
    step3_approve: [],
    step4_post: [],
    step5_exceptions: [],
  };

  for (const inv of state.pendingInvoices) {
    if (inv.amount <= AUTO_APPROVE_THRESHOLD && inv.confidence >= MIN_APPROVE_CONFIDENCE) {
      plan.step3_approve.push(inv.id);
    } else {
      plan.step5_exceptions.push({
        type: inv.amount > AUTO_APPROVE_THRESHOLD ? 'amount_threshold' : 'low_confidence',
        entityId: inv.id,
        entityType: 'invoice',
        reason: inv.amount > AUTO_APPROVE_THRESHOLD ? `Amount R${inv.amount.toLocaleString()} exceeds threshold` : `Confidence ${(inv.confidence * 100).toFixed(0)}% too low`,
        severity: inv.amount > AUTO_APPROVE_THRESHOLD ? 'high' : 'medium',
      });
    }
  }

  for (const je of state.pendingJournals) {
    if (je.status === 'draft') {
      plan.step4_post.push(je.id);
    }
  }

  return plan;
}

export function shouldAutoCategorizeTx(suggestion: CategorizationSuggestion | null): boolean {
  if (!suggestion) return false;
  return suggestion.confidence >= MIN_CATEGORIZE_CONFIDENCE;
}

export function shouldAutoMatchTx(candidate: MatchCandidate | null): boolean {
  if (!candidate) return false;
  return candidate.confidence >= MIN_MATCH_CONFIDENCE;
}

export function shouldAutoApproveInvoice(amount: number, confidence: number, threshold: number): boolean {
  return amount <= threshold && confidence >= MIN_APPROVE_CONFIDENCE;
}

export function summarizeCloseRun(results: CloseRunResults, durationMs: number): CloseRunSummary {
  const totalActions = results.categorized + results.matched + results.approved + results.posted;
  return {
    totalActions,
    successful: totalActions,
    failed: 0,
    exceptions: results.exceptions.length,
    duration: durationMs,
    timestamp: new Date().toISOString(),
  };
}

export function prioritizeExceptions(exceptions: CloseException[]): CloseException[] {
  const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...exceptions].sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));
}
