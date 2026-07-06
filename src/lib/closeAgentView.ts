/**
 * Close Agent — pure view-model helpers (P5.2 surface).
 *
 * No React, no DB. Shared by the Month-End tab (the agent's home) and the
 * bureau cockpit rollup. Keeping this logic here makes it unit-testable and
 * keeps the components thin.
 */

import type { CloseProposal, AccuracyStats } from '@/modules/accounting/services/gl/closeRun/closeRunTypes';
import type { PortfolioRow } from '@/modules/accounting/services/workbench/portfolioWorkbenchService';

/** A fiscal period as returned by GET /api/accounting/fiscal-periods (slim). */
export interface SlimPeriod {
  id: string;
  startDate: string;
  status: string;
}

/**
 * Resolve the fiscal-period UUID for a 'YYYY-MM' month by matching the period
 * whose start date is the first of that month. Tolerates a full ISO timestamp.
 */
export function resolvePeriodId(
  periods: SlimPeriod[],
  month: string,
): { id: string; status: string } | null {
  const first = `${month}-01`;
  const hit = periods.find(p => String(p.startDate).slice(0, 10) === first);
  return hit ? { id: hit.id, status: hit.status } : null;
}

export interface GroupedProposals {
  autoPost: CloseProposal[];
  advisory: CloseProposal[];
  /** proposals of either kind still awaiting a decision. */
  pendingCount: number;
}

/** Split proposals into the agent-executable set and the advisory (dismiss-only) set. */
export function groupProposals(proposals: CloseProposal[]): GroupedProposals {
  const autoPost = proposals.filter(p => p.actionType === 'auto_post');
  const advisory = proposals.filter(p => p.actionType === 'advisory');
  const pendingCount = proposals.filter(p => p.status === 'proposed').length;
  return { autoPost, advisory, pendingCount };
}

/** Honest one-line phrasing of the accuracy panel. */
export function formatAcceptance(acc: AccuracyStats): string {
  if (acc.acceptanceRate === null) {
    return `The agent proposed ${acc.proposed} posting${acc.proposed === 1 ? '' : 's'} — no decisions yet.`;
  }
  const pct = Math.round(acc.acceptanceRate * 100);
  return `You accepted ${acc.posted} of ${acc.decided} proposed postings (${pct}%).`;
}

/**
 * A client is "closable today" when the month-end workbench shows no red flags:
 * nothing needs attention, nothing is blocked, the trial balance is balanced,
 * and the client's data loaded at all. Deliberately strict — the headline must
 * not overstate readiness.
 */
export function isClientClosable(row: PortfolioRow): boolean {
  return !row.failed
    && row.attentionCount === 0
    && row.blockedCount === 0
    && row.trialBalanceBalanced;
}

export function countClosable(rows: PortfolioRow[]): number {
  return rows.filter(isClientClosable).length;
}
