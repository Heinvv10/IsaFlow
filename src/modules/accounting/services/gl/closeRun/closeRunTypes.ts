/**
 * Close Agent v1 — shared types.
 *
 * The close-run engine turns a period's readiness checklist into a persisted
 * list of PROPOSALS. Each proposal is either:
 *   - auto_post: the agent can execute it on one-click human approval (post a
 *     draft journal through the existing posting service), or
 *   - advisory:  the agent can only surface it with evidence — a human must
 *     clear it in the relevant module (nothing here posts).
 *
 * Nothing posts without an explicit per-proposal approval (P5.3 honesty rule).
 */

export type ProposalKind =
  | 'post_draft_journal'
  | 'bank_unreconciled'
  | 'unposted_journals'
  | 'ar_untied'
  | 'ap_untied'
  | 'vat_unreviewed'
  | 'tb_unbalanced';

export type ProposalActionType = 'auto_post' | 'advisory';

export type ProposalStatus =
  | 'proposed'
  | 'approved'
  | 'posted'
  | 'rejected'
  | 'failed'
  | 'dismissed';

export type CloseRunStatus = 'open' | 'completed' | 'abandoned';

export type Decision = 'approve' | 'reject' | 'dismiss';

/**
 * The evidence a proposal shows for itself — the honesty rule made concrete.
 * `summary` is human-readable; `rows`/`count`/`query` expose the underlying
 * data so the reviewer can verify the agent's claim before approving.
 */
export interface ProposalEvidence {
  summary: string;
  query?: string;
  rows?: Array<Record<string, string | number>>;
  count?: number;
  fixHref?: string;
}

/** A proposal before persistence (pure builder output). */
export interface ProposalDraft {
  kind: ProposalKind;
  actionType: ProposalActionType;
  title: string;
  reasoning: string;
  evidence: ProposalEvidence;
  targetEntityType: string | null;
  targetEntityId: string | null;
}

/** A persisted proposal (a ProposalDraft plus its lifecycle state). */
export interface CloseProposal extends ProposalDraft {
  id: string;
  closeRunId: string;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}

/** A persisted close run. */
export interface CloseRun {
  id: string;
  companyId: string;
  fiscalPeriodId: string;
  periodLabel: string;
  status: CloseRunStatus;
  overallReadiness: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CloseRunWithProposals {
  run: CloseRun;
  proposals: CloseProposal[];
}

/** A draft journal fetched for drill-down into auto_post proposals. */
export interface DraftJournalRow {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  totalDebit: number;
  lineCount: number;
}

/** The concrete, actionable rows the builder drills into (no DB inside builder). */
export interface ActionableCloseState {
  draftJournals: DraftJournalRow[];
}

/** Raw proposal-outcome tallies used to compute accuracy stats. */
export interface ProposalOutcomeCounts {
  proposed: number;
  approved: number;
  posted: number;
  rejected: number;
  failed: number;
  dismissed: number;
}

export interface AccuracyStats {
  /** posted / (posted + rejected) over auto_post proposals; null if none decided. */
  acceptanceRate: number | null;
  proposed: number;
  posted: number;
  rejected: number;
  failed: number;
  dismissed: number;
  /** posted + rejected — the acceptance denominator. */
  decided: number;
}
