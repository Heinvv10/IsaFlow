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
  opening_balance_cleared: 'opening_balance_residual',
  // Advisory here, blocking in close_fiscal_period. The Month-End Workbench
  // shows a person what stands in the way and lets them decide; a caller that
  // is not a person gets a refusal. Same check, two audiences.
  orphan_period_journals: 'orphan_period_journals',
};

function moneyZa(n: number): string {
  return `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A draft is a candidate for one-click posting only when it is well-formed:
 * it has lines and it balances. postJournalEntry would reject anything else, so
 * proposing it as auto_post would be dishonest ("balanced") and would 500-ladder
 * on approval. Malformed drafts stay counted in the unposted advisory instead.
 */
export function isPostableDraft(je: DraftJournalRow): boolean {
  return je.lineCount > 0 && Math.abs(je.totalDebit - je.totalCredit) < 0.01;
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
      query: 'gl_journal_entries WHERE status = \'draft\' AND fiscal_period_id = <period>',
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
  // Only well-formed drafts become one-click postings; the rest stay counted in
  // the unposted advisory so nothing readiness flagged goes missing.
  const postable = actionable.draftJournals.filter(isPostableDraft);
  const autoPosts = postable.map(draftJournalProposal);

  // Suppress the aggregate unposted advisory ONLY when every unposted entry the
  // readiness check counted was drilled into a postable proposal. If there are
  // pending/unbalanced/out-of-period unposted entries the agent cannot post,
  // the advisory stays so the reviewer still sees them (honesty over tidiness).
  const fullyDrilled = actionable.unpostedCount > 0 && postable.length >= actionable.unpostedCount;

  const advisories = readiness.items
    .filter(it => it.status === 'fail' || it.status === 'warn')
    .filter(it => !(it.key === 'unposted_journals' && fullyDrilled))
    .sort((a, b) => severityRank(a.status) - severityRank(b.status))
    .map(advisoryProposal);

  return [...autoPosts, ...advisories];
}

// ── Honesty guard: nothing posts without an explicit, valid approval ─────────

/**
 * The single source of truth for which decisions are legal on a proposal.
 *  - only 'proposed' proposals are decidable (idempotency — no double-posting);
 *  - auto_post proposals accept 'approve' (post) or 'reject' (decline) ONLY —
 *    never 'dismiss': a dismissed auto_post is excluded from the acceptance
 *    denominator (posted + rejected), so allowing dismiss would let a decliner
 *    silently mask a rejection and inflate the reported accuracy (honesty rule);
 *  - advisory proposals accept 'dismiss' (acknowledged) or 'reject' ONLY —
 *    never 'approve' (the agent never posts an advisory item).
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
  if (decision === 'dismiss' && proposal.actionType !== 'advisory') {
    return { ok: false, reason: 'This auto-post proposal cannot be dismissed — approve to post it, or reject to decline; dismissing would hide it from the acceptance rate.' };
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
