/**
 * Close Agent v1 — orchestration service.
 *
 * Composes existing pieces, rebuilds nothing:
 *   - periodCloseReadinessService.getCloseReadiness → the checklist state
 *   - closeRunProposalBuilder (pure)               → proposals + reasoning + evidence
 *   - journalEntryPostingService.postJournalEntry  → the only posting the agent runs
 *   - auditTrailService.logAuditOrThrow            → the financial audit trail
 *
 * The honesty rules (P5.3) live here and are non-negotiable:
 *   - NOTHING posts without an explicit per-proposal approval (decideProposal).
 *   - Only 'auto_post' proposals ever execute; 'advisory' proposals can only be
 *     dismissed once a human has cleared them elsewhere.
 *   - Every executed approval writes an audit_log row carrying the proposal's
 *     reasoning, in the SAME request transaction as the post — post and audit
 *     commit together or roll back together.
 */

import { log } from '@/lib/logger';
import { getCloseReadiness } from '../periodCloseReadinessService';
import { getFiscalPeriodById } from '../fiscalPeriodService';
import { postJournalEntry } from '../journalEntryPostingService';
import { logAuditOrThrow } from '../../core/auditTrailService';
import { buildProposals, validateDecision, computeAccuracy } from './closeRunProposalBuilder';
import * as repo from './closeRunRepo';
import type {
  CloseRunWithProposals,
  CloseProposal,
  Decision,
  AccuracyStats,
} from './closeRunTypes';

export const CLOSE_AGENT = 'close-agent:v1';

export class CloseRunNotFoundError extends Error {
  constructor(msg: string) { super(msg); this.name = 'CloseRunNotFoundError'; }
}
export class ProposalDecisionError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ProposalDecisionError'; }
}

// ── Start ────────────────────────────────────────────────────────────────────

/**
 * Compute the period's checklist state, turn it into proposals, and persist a
 * fresh close run. Proposals reflect CURRENT state — anything already posted
 * since a prior run simply does not reappear.
 */
export async function startCloseRun(
  companyId: string,
  periodId: string,
  userId: string,
): Promise<CloseRunWithProposals> {
  const period = await getFiscalPeriodById(companyId, periodId);
  if (!period) throw new CloseRunNotFoundError(`Fiscal period ${periodId} not found`);

  const readiness = await getCloseReadiness(companyId, periodId);
  if (!readiness) throw new CloseRunNotFoundError(`Fiscal period ${periodId} not found`);

  const draftJournals = await repo.fetchDraftJournals(companyId, period.startDate, period.endDate);
  const drafts = buildProposals(readiness, { draftJournals });

  const run = await repo.insertCloseRun(
    companyId, periodId, readiness.periodLabel, readiness.overallStatus, userId,
  );
  const proposals = await repo.insertProposals(companyId, run.id, drafts);

  log.info('Close run started', {
    companyId, periodId, runId: run.id,
    proposals: proposals.length,
    autoPost: proposals.filter(p => p.actionType === 'auto_post').length,
  }, 'close-agent');

  return { run, proposals };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getCloseRun(
  companyId: string,
  opts: { runId?: string; periodId?: string },
): Promise<CloseRunWithProposals | null> {
  if (opts.runId) return repo.getCloseRunById(companyId, opts.runId);
  if (opts.periodId) return repo.getLatestCloseRunForPeriod(companyId, opts.periodId);
  return null;
}

export async function getAccuracy(companyId: string): Promise<AccuracyStats> {
  return computeAccuracy(await repo.getOutcomeCounts(companyId));
}

// ── Decide (the ONLY posting path) ───────────────────────────────────────────

/**
 * Apply a human decision to one proposal. 'approve' executes the underlying
 * action (post_draft_journal → postJournalEntry) and writes the audit row;
 * 'reject'/'dismiss' record the outcome without posting anything.
 */
export async function decideProposal(
  companyId: string,
  runId: string,
  proposalId: string,
  decision: Decision,
  userId: string,
): Promise<CloseProposal> {
  const proposal = await repo.getProposalById(companyId, proposalId);
  if (!proposal || proposal.closeRunId !== runId) {
    throw new CloseRunNotFoundError(`Proposal ${proposalId} not found in close run ${runId}`);
  }

  const check = validateDecision(proposal, decision);
  if (!check.ok) throw new ProposalDecisionError(check.reason);

  if (decision === 'reject' || decision === 'dismiss') {
    const status = decision === 'reject' ? 'rejected' : 'dismissed';
    const updated = await repo.updateProposalOutcome(companyId, proposalId, status, userId, null);
    if (!updated) throw new ProposalDecisionError('Proposal was already decided — reload the close run.');
    return updated;
  }

  // decision === 'approve' — only reachable for auto_post proposals (guard above).
  return approveAutoPost(companyId, proposal, userId);
}

async function approveAutoPost(
  companyId: string,
  proposal: CloseProposal,
  userId: string,
): Promise<CloseProposal> {
  if (proposal.kind !== 'post_draft_journal' || !proposal.targetEntityId) {
    throw new ProposalDecisionError(`Unsupported auto_post proposal: ${proposal.kind}`);
  }

  // 1. Post through the existing service — validates draft/period-open/balance
  //    and prevents double-posting (the JE row itself serialises concurrent
  //    approvals; the second sees status='posted' and throws).
  const entry = await postJournalEntry(companyId, proposal.targetEntityId, userId);

  // 2. Audit with the proposal's reasoning — SAME request tx as the post, so a
  //    posted journal ALWAYS carries its audit row (or both roll back).
  await logAuditOrThrow({
    companyId,
    userId,
    action: 'post',
    entityType: 'gl_journal_entry',
    entityId: proposal.targetEntityId,
    entityRef: entry.entryNumber,
    changes: {
      fields: [{ field: 'status', old: 'draft', new: 'posted', label: 'Status' }],
      metadata: {
        source: CLOSE_AGENT,
        closeRunId: proposal.closeRunId,
        proposalId: proposal.id,
        reasoning: proposal.reasoning,
      },
    },
  });

  // 3. Record the outcome on the proposal ledger.
  const updated = await repo.updateProposalOutcome(
    companyId, proposal.id, 'posted', userId,
    { entryNumber: entry.entryNumber, journalEntryId: entry.id },
  );
  if (!updated) {
    // Would require the proposal to change state mid-request. Surface loudly
    // rather than return a stale row — the post+audit already committed here.
    throw new ProposalDecisionError('Close proposal changed state during approval — reload the close run.');
  }

  log.info('Close agent posted a proposed journal', {
    companyId, proposalId: proposal.id, entryNumber: entry.entryNumber,
  }, 'close-agent');
  return updated;
}

// ── Complete ─────────────────────────────────────────────────────────────────

/**
 * Mark a close run completed. Refuses while any proposal is still undecided —
 * you cannot honestly "close" while the checklist has open items.
 */
export async function completeCloseRun(
  companyId: string,
  runId: string,
  userId: string,
): Promise<CloseRunWithProposals> {
  const existing = await repo.getCloseRunById(companyId, runId);
  if (!existing) throw new CloseRunNotFoundError(`Close run ${runId} not found`);

  const undecided = existing.proposals.filter(p => p.status === 'proposed').length;
  if (undecided > 0) {
    throw new ProposalDecisionError(`${undecided} proposal(s) still undecided — decide every item before completing the close.`);
  }

  await repo.updateCloseRunStatus(companyId, runId, 'completed');
  await logAuditOrThrow({
    companyId,
    userId,
    action: 'approve',
    entityType: 'close_run',
    entityId: runId,
    entityRef: existing.run.periodLabel,
    changes: {
      fields: [{ field: 'status', old: existing.run.status, new: 'completed', label: 'Close run status' }],
      metadata: {
        source: CLOSE_AGENT,
        period: existing.run.periodLabel,
        posted: String(existing.proposals.filter(p => p.status === 'posted').length),
        dismissed: String(existing.proposals.filter(p => p.status === 'dismissed').length),
      },
    },
  });

  const updated = await repo.getCloseRunById(companyId, runId);
  return updated!;
}
