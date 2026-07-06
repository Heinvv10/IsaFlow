/**
 * Close Agent v1 — pure proposal builder + honesty guards.
 *
 * PURE (no DB, no clock): given a period's readiness checklist and the concrete
 * actionable rows, produce the list of proposals. This is the heart of the
 * "propose → approve → post" flow and the primary TDD target — every posting
 * the agent later executes originates here, with its reasoning and evidence
 * attached up front.
 */

import type { CloseReadiness, ChecklistItem, ChecklistItemKey } from '../periodCloseReadinessService';
import type {
  ProposalDraft,
  ProposalKind,
  ActionableCloseState,
  DraftJournalRow,
  Decision,
  ProposalActionType,
  ProposalStatus,
  ProposalOutcomeCounts,
  AccuracyStats,
} from './closeRunTypes';

// ── Readiness item → advisory proposal metadata ──────────────────────────────
//
// Each failing/warning readiness check (other than unposted_journals, which we
// drill into as auto_post proposals) becomes one advisory proposal.

const ADVISORY_KIND: Record<Exclude<ChecklistItemKey, 'unposted_journals'>, ProposalKind> = {
  bank_reconciled: 'bank_unreconciled',
  ar_ties: 'ar_untied',
  ap_ties: 'ap_untied',
  vat_reviewed: 'vat_unreviewed',
  tb_balanced: 'tb_unbalanced',
};

function moneyZa(n: number): string {
  return `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function draftJournalProposal(je: DraftJournalRow): ProposalDraft {
  return {
    kind: 'post_draft_journal',
    actionType: 'auto_post',
    title: `Post ${je.entryNumber}`,
    reasoning:
      `${je.entryNumber} (${je.entryDate}) is a balanced draft journal for ${moneyZa(je.totalDebit)} ` +
      `across ${je.lineCount} line${je.lineCount === 1 ? '' : 's'}. Draft journals must be posted before ` +
      `the period can close — approve to post it through the general ledger.`,
    evidence: {
      summary: `Draft journal ${je.entryNumber} — ${je.description || 'no description'} — ${moneyZa(je.totalDebit)}.`,
      query: 'gl_journal_entries WHERE status = \'draft\' in this period',
      count: je.lineCount,
      rows: [
        { entryNumber: je.entryNumber, entryDate: je.entryDate, amount: je.totalDebit, lines: je.lineCount },
      ],
      fixHref: '/accounting/journal-entries',
    },
    targetEntityType: 'gl_journal_entry',
    targetEntityId: je.id,
  };
}

function advisoryProposal(it: ChecklistItem): ProposalDraft {
  const kind = ADVISORY_KIND[it.key as Exclude<ChecklistItemKey, 'unposted_journals'>] ?? 'unposted_journals';
  return {
    kind,
    actionType: 'advisory',
    title: it.label,
    reasoning:
      `${it.reason} The close agent cannot resolve this automatically — open the linked module, ` +
      `clear it, then re-run the close checklist.`,
    evidence: {
      summary: it.reason,
      fixHref: it.fixHref,
    },
    targetEntityType: null,
    targetEntityId: null,
  };
}

/** fail before warn; stable within a group. */
function severityRank(status: ChecklistItem['status']): number {
  return status === 'fail' ? 0 : status === 'warn' ? 1 : 2;
}

/**
 * Build the proposal list for a close run. auto_post proposals (one per draft
 * journal) come first, then advisory proposals (fail before warn). Passing
 * readiness items produce nothing.
 */
export function buildProposals(
  readiness: CloseReadiness,
  actionable: ActionableCloseState,
): ProposalDraft[] {
  const autoPosts = actionable.draftJournals.map(draftJournalProposal);
  const drilledUnposted = autoPosts.length > 0;

  const advisories = readiness.items
    .filter(it => it.status === 'fail' || it.status === 'warn')
    // unposted_journals is drilled into per-journal auto_post proposals; keep
    // the aggregate advisory only when we could not fetch the underlying drafts.
    .filter(it => !(it.key === 'unposted_journals' && drilledUnposted))
    .sort((a, b) => severityRank(a.status) - severityRank(b.status))
    .map(advisoryProposal);

  return [...autoPosts, ...advisories];
}

// ── Honesty guard: nothing posts without an explicit, valid approval ─────────

/**
 * The single source of truth for which decisions are legal on a proposal.
 *  - only 'proposed' proposals are decidable (idempotency — no double-posting);
 *  - 'approve' is legal ONLY on auto_post proposals (advisory items never post);
 *  - advisory proposals accept 'dismiss' (acknowledged) or 'reject'.
 */
export function validateDecision(
  proposal: { actionType: ProposalActionType; status: ProposalStatus | string },
  decision: Decision,
): { ok: true } | { ok: false; reason: string } {
  if (proposal.status !== 'proposed') {
    return { ok: false, reason: `Proposal already ${proposal.status} — cannot ${decision}.` };
  }
  if (decision === 'approve' && proposal.actionType !== 'auto_post') {
    return { ok: false, reason: 'Advisory items cannot be approved — the agent never posts them; dismiss once handled.' };
  }
  return { ok: true };
}

// ── Accuracy stats (proposed vs accepted), shown honestly ────────────────────

/**
 * Acceptance rate = posted / (posted + rejected) over auto_post proposals: when
 * the agent proposed a posting, how often did the human accept it. Failed posts
 * are reported but excluded from the denominator (they are execution errors,
 * not human rejections). Returns null when no auto_post proposal was decided.
 */
export function computeAccuracy(counts: ProposalOutcomeCounts): AccuracyStats {
  const decided = counts.posted + counts.rejected;
  return {
    acceptanceRate: decided === 0 ? null : counts.posted / decided,
    proposed: counts.proposed,
    posted: counts.posted,
    rejected: counts.rejected,
    failed: counts.failed,
    dismissed: counts.dismissed,
    decided,
  };
}
