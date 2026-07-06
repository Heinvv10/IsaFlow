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
  /** proposals not yet in a terminal state — mirrors the engine's undecided set. */
  pendingCount: number;
}

// Terminal proposal states — matches the server's completeCloseRun guard
// (anything else — proposed/approved/failed — blocks completion).
const TERMINAL_STATUSES = new Set(['posted', 'rejected', 'dismissed']);

/** Split proposals into the agent-executable set and the advisory (dismiss-only) set. */
export function groupProposals(proposals: CloseProposal[]): GroupedProposals {
  const autoPost = proposals.filter(p => p.actionType === 'auto_post');
  const advisory = proposals.filter(p => p.actionType === 'advisory');
  const pendingCount = proposals.filter(p => !TERMINAL_STATUSES.has(p.status)).length;
  return { autoPost, advisory, pendingCount };
}

/** Honest one-line phrasing of the (company-wide, all-time) accuracy panel. */
export function formatAcceptance(acc: AccuracyStats): string {
  if (acc.acceptanceRate === null) {
    return `The agent has proposed ${acc.proposed} posting${acc.proposed === 1 ? '' : 's'} — no decisions yet.`;
  }
  const pct = Math.round(acc.acceptanceRate * 100);
  return `Across all close runs, you accepted ${acc.posted} of ${acc.decided} proposed postings (${pct}%).`;
}

// The workbench cards that genuinely gate a month-end close. Excluded on purpose:
// sales/purchases (overdue AR/AP is not a close blocker), afs (year-end, not
// monthly), and review (the close action itself — only 'ready' once already
// closed, so requiring it would make "closable today" ≈ "already closed").
const CLOSE_BLOCKER_CARDS = ['banking', 'exceptions'];

/**
 * A fast, conservative "ready to close" heuristic over the month-end WORKBENCH
 * signals: no card needs attention, nothing is blocked, the trial balance
 * balances, and every close-blocking prep card is fully 'ready' — bank
 * reconciled and the exceptions card clear (draft invoices/bills, unclassified
 * bank txns AND unposted draft journals; see buildExceptionsCard). An
 * 'in_progress'/'not_started' blocker is NOT counted. This is a portfolio
 * heuristic, NOT the authoritative check — the per-client close run
 * (getCloseReadiness's six checks + proposals) is what actually gates a close.
 */
export function isClientClosable(row: PortfolioRow): boolean {
  if (row.failed || !row.trialBalanceBalanced) return false;
  if (row.attentionCount > 0 || row.blockedCount > 0) return false;
  return CLOSE_BLOCKER_CARDS.every(id => {
    const card = row.cards.find(c => c.id === id);
    return card != null && card.status === 'ready';
  });
}

export function countClosable(rows: PortfolioRow[]): number {
  return rows.filter(isClientClosable).length;
}
