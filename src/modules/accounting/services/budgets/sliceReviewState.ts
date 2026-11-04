/**
 * The ONLY place a budget slice's review status changes (budgets P5-6, spec §3f; mirrors
 * commentary/commentaryState.ts).
 *
 *   open | returned  --submit-->   submitted   a holder of that slice
 *   submitted        --approve-->  approved    an owner or admin
 *   submitted        --return-->   returned    an owner or admin, with a note (1-2 000 characters)
 *   approved         --return-->   returned    the same: reopening an approved slice (r6)
 *
 * Only on a draft version. The UPDATE's WHERE repeats the from-state the actor saw (not any allowed
 * one: a return racing an approve must not turn into a reopen), so of two racing moves (two
 * submits, an approve and a return) exactly one wins and the other is a 409 naming the status it
 * found. Order of locks: the version FOR SHARE (bounded wait), then the slice row: the grid save takes
 * the version first too, so a save and a submit of one slice serialise, and the version's approve
 * (FOR NO KEY UPDATE on the version) waits for a move in flight, or the move sees the version approved.
 * Actor and time stamps are migration 954's trigger's; migration 955's trigger holds the same move
 * rules as the backstop. Every move writes one audit row (entity 'budget', the version) and notifies:
 * a submit the owners and admins, an approve or return the slice's holders (the bell).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow, type AuditAction } from '../core/auditTrailService';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { notifyUsers } from '../notifications/userNotificationService';
import { scheduleBudgetRoll } from './drivers/budgetRollQueue';
import { BudgetVersionError } from './budgetVersionTypes';
import type { SliceStatus } from './holderSlices';
import { readSlice, sliceHolderIds, sliceReviewers, type SliceReview } from './sliceReviewRead';

export type SliceAction = 'submit' | 'approve' | 'return';

export const SLICE_ACTIONS: readonly SliceAction[] = ['submit', 'approve', 'return'];
export const MAX_SLICE_NOTE = 2000;

const MOVES: Record<SliceAction, { from: readonly SliceStatus[]; to: SliceStatus; audit: AuditAction }> = {
  submit: { from: ['open', 'returned'], to: 'submitted', audit: 'update' },
  approve: { from: ['submitted'], to: 'approved', audit: 'approve' },
  // An approved slice can be reopened (returned to its holder) too (r6): the frozen-slice refusals say "return the slice first".
  return: { from: ['submitted', 'approved'], to: 'returned', audit: 'reject' },
};

export type SliceTransition =
  | { ok: true; next: SliceStatus }
  | { ok: false; code: 'BUDGET_SLICE_STATE' | 'BUDGET_SLICE_FORBIDDEN'; reason: string };

const PAST: Record<SliceAction, string> = { submit: 'submitted', approve: 'approved', return: 'returned' };

/** The pure rule: may `who` take `action` on a slice in `current`? */
export function nextSliceStatus(
  current: SliceStatus, action: SliceAction, who: { holder: boolean; reviewer: boolean },
): SliceTransition {
  const move = MOVES[action];
  if (action === 'submit' && !who.holder) {
    return { ok: false, code: 'BUDGET_SLICE_FORBIDDEN', reason: 'Only a holder of this budget slice can submit it' };
  }
  if (action !== 'submit' && !who.reviewer) {
    return { ok: false, code: 'BUDGET_SLICE_FORBIDDEN', reason: `Only an owner or admin can ${action} a budget slice` };
  }
  if (!move.from.includes(current)) {
    return { ok: false, code: 'BUDGET_SLICE_STATE', reason: `This budget slice is ${current}; it cannot be ${PAST[action]}` };
  }
  return { ok: true, next: move.to };
}

/** A note for `action`: required (1-2 000 after trimming) on a return, optional on an approve, none on a submit. */
export function sliceNote(action: SliceAction, raw: unknown): string | null {
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (note.length > MAX_SLICE_NOTE) throw new BudgetVersionError('BUDGET_VERSION_INPUT', `A note is at most ${MAX_SLICE_NOTE} characters`);
  if (action === 'return' && note === '') throw new BudgetVersionError('BUDGET_VERSION_INPUT', 'Returning a slice needs a note saying what to change');
  return action === 'submit' || note === '' ? null : note;
}

export interface SliceActor { userId: string; role: string }

export async function transitionSlice(
  companyId: string, sliceId: string, action: SliceAction, actor: SliceActor, rawNote?: unknown,
): Promise<SliceReview> {
  const note = sliceNote(action, rawNote);
  const before = await readSlice(companyId, sliceId);
  const holders = await sliceHolderIds(companyId, before);
  const rule = nextSliceStatus(before.status, action, {
    holder: holders.includes(actor.userId), reviewer: actor.role === 'owner' || actor.role === 'admin',
  });
  if (!rule.ok) throw new BudgetVersionError(rule.code, rule.reason);
  if (before.versionStatus !== 'draft') {
    throw new BudgetVersionError('BUDGET_SLICE_STATE', `Budget slices are reviewed on a draft version only; this version is ${before.versionStatus}`);
  }

  // The version first (FOR SHARE), then the slice: the lock order every slice writer follows.
  const version = (await withRowLockBudget(
    () => sql`SELECT status FROM budget_versions WHERE id = ${before.versionId}::UUID AND company_id = ${companyId}::UUID FOR SHARE`,
    () => new RowLockTimeoutError('This budget version'),
  )) as DbRow[];
  if (version[0]?.status !== 'draft') {
    throw new BudgetVersionError('BUDGET_SLICE_STATE', `Budget slices are reviewed on a draft version only; this version is ${String(version[0]?.status ?? 'gone')}`);
  }
  const move = MOVES[action];
  const rows = (await withRowLockBudget(
    () => sql`
      UPDATE budget_slice_reviews SET status = ${move.to},
             decision_note = CASE WHEN ${action} = 'submit' THEN decision_note ELSE ${note} END
       WHERE id = ${sliceId}::UUID AND company_id = ${companyId}::UUID AND status = ${before.status}
      RETURNING to_char(COALESCE(CASE WHEN status = 'submitted' THEN submitted_at ELSE decided_at END, now()) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    `,
    () => new RowLockTimeoutError('This budget slice'),
  )) as DbRow[];
  if (!rows[0]) {
    const now = await readSlice(companyId, sliceId);
    throw new BudgetVersionError('BUDGET_SLICE_STATE', `This budget slice is now ${now.status}; it cannot be ${PAST[action]}`);
  }
  const at = String(rows[0].at);

  await logAuditOrThrow({
    companyId, userId: actor.userId, action: move.audit, entityType: 'budget', entityId: before.versionId,
    entityRef: `Budget slice ${before.label}`,
    changes: {
      fields: [{ field: 'slice_status', old: before.status, new: move.to, label: 'Slice review status' }],
      metadata: { sliceId, sliceAction: action, slice: before.label, ...(note === null ? {} : { note }) },
    },
  });

  const href = action === 'submit' ? '/accounting/budgets/review' : `/accounting/budgets/review?version=${before.versionId}`;
  const recipients = action === 'submit'
    ? (await sliceReviewers(companyId, actor.userId))
    : holders.filter((u) => u !== actor.userId);
  await notifyUsers(companyId, recipients, {
    kind: 'budget_slice', refId: sliceId, href,
    title: action === 'submit' ? `Budget slice submitted: ${before.label}` : `Budget slice ${PAST[action]}: ${before.label}`,
    body: `${before.versionName} (FY${before.fiscalYear})${note ? `: ${note}` : ''}`,
    // One per move: a resubmission after a return notifies again.
    dedupeKey: `budget_slice:${sliceId}:${action}:${at}`,
  });
  // A returned slice is the holder's again: a rolling forecast that left its cells re-rolls after commit (P4's roll).
  if (action === 'return') await rerollLeftCells(companyId, before.versionId);
  return readSlice(companyId, sliceId);
}

/** Queues the version's year roll (after commit) when its rolling row recorded cells left in locked slices. */
async function rerollLeftCells(companyId: string, versionId: string): Promise<void> {
  const rows = (await sql`
    SELECT fy.end_date::TEXT AS end_date FROM budget_rolling_forecasts r
      JOIN fiscal_years fy ON fy.company_id = r.company_id AND fy.fiscal_year = r.fiscal_year
     WHERE r.company_id = ${companyId}::UUID AND r.version_id = ${versionId}::UUID AND r.slice_skipped > 0
  `) as DbRow[];
  if (rows[0]) scheduleBudgetRoll(companyId, String(rows[0].end_date));
}
