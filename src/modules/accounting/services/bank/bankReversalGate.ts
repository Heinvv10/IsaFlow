/**
 * Reversal gating (forensic-controls step 2; Hein's decision 4, 2026-10-09).
 *
 * Under enforcement of the arm's type, reversing a posted bank allocation is a
 * decision about money that already moved, so:
 *   - an agent (MCP), a job, or a "login as" session may not make it (403);
 *   - a person may, unless they made the allocation — then only as the sole
 *     approver on the admin floor (R-035 Q2); otherwise 403
 *     ALLOCATOR_MAY_NOT_REVERSE, naming the way out;
 *   - every reversal permitted under enforcement is audited.
 *
 * The arm, by the allocation side's own mapping (importerArmOf): a supplier
 * payment or payment batch on an outflow is `supplier_payment` (coupled with
 * `payment_batch`); a customer receipt, and any document on money in, is
 * ungated; a customer refund (money out) and a plain journal (account,
 * split, transfer, auto-post) are `manual_journal`. The allocator: the chain ROOT
 * journal's `created_by`, the payment document's `created_by`, and the
 * auto-post run's `created_by` (the person who triggered the sweep) — every
 * one of them; the zero uuid (the system user) is nobody.
 *
 * One choke point, `reverseReconciledTransaction`, after the line's lock and
 * before any write; the MCP reverse tools ask `agentReversalRefusal` first, so
 * a dry run agrees with the live call; `undoRun` / `undoAnyway` are judged at
 * the RUN level up front by `assertMayUndoRun` (a provisional row is reversed
 * without the choke point).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { assertHumanSession, BankControlError } from './bankControlRefusal';
import { allocationFacts, armEnforced, armLabel, isSoleAsCaller, sameUser, type BankArm } from './bankLineImporterGate';
import { peekLineChain } from './bankChainLineReversal';
import { refuseJournalCashOfCompletedReconciliation } from './reconciledCash';
import { findJournalChainRoot } from '../shared/journalChainHead';

const NOBODY = '00000000-0000-0000-0000-000000000000';
const ACTION = 'reverse a bank allocation while approval is on';

/** What a permitted reversal under enforcement records. */
export interface ReversalClearance { arm: BankArm; allocators: string[]; soleApprover: boolean }

/**
 * The choke point's check (reverseReconciledTransaction): `line` locked, its
 * own refusals passed, nothing written yet. Null when the arm is ungated or not
 * enforced (nothing to audit); otherwise the clearance to audit once the
 * reversal is done. Throws the BankControlError refusals.
 */
export async function assertMayReverse(
  companyId: string, line: DbRow, rootId: string | null, actorUserId: string,
): Promise<ReversalClearance | null> {
  const facts = await allocationFacts(companyId, line, rootId);
  if (!facts || !(await armEnforced(companyId, facts.arm))) return null;
  await assertHumanSession(ACTION);
  const own = facts.allocators.some((id) => sameUser(id, actorUserId));
  const soleApprover = own && await isSoleAsCaller(companyId, actorUserId);
  if (own && !soleApprover) {
    throw new BankControlError('ALLOCATOR_MAY_NOT_REVERSE',
      `You made this allocation, so while ${armLabel(facts.arm)} approval is on you cannot reverse it yourself. `
      + 'Ask another member to reverse it.');
  }
  return { arm: facts.arm, allocators: facts.allocators, soleApprover };
}

/** The audit row of a reversal `assertMayReverse` cleared; returns `result` for the caller to pass on. */
export async function auditedReversal<T>(
  companyId: string, bankTxId: string, actorUserId: string, clearance: ReversalClearance | null, result: T,
): Promise<T> {
  if (clearance) {
    await logAuditOrThrow({
      companyId, userId: actorUserId, action: 'reverse', entityType: 'bank_transaction', entityId: bankTxId,
      changes: { fields: [], metadata: {
        allocator: clearance.allocators.join(','), armType: clearance.arm, soleApprover: String(clearance.soleApprover),
      } },
    });
  }
  return result;
}

/**
 * The GL reversal's entrance (journal-entries-action `reverse`, MCP
 * `reverse_journal_entry`) for a journal whose reversal chain books a
 * statement line's cash — a bank allocation, matched or provisional. First the
 * chain's statement lines are LOCKED in id order (refuseJournalCashOfCompleted
 * Reconciliation: bank lines before the journal, the D8/D12 order; a completed
 * reconciliation refuses 409). Then, on that locked set, under enforcement of
 * the allocation's arm the reversal is refused, 409, for everyone: the bank
 * line's own reverse is where the allocator and agent checks and the audit
 * sit, and it resets the line. Returns the locked set for reverseJournalEntry's
 * `cashLinesLocked`: a line matched to the chain AFTER this read is refused
 * under the reversal's claim (a typed retry, 503), and the retry is judged
 * here. Enforcement off: unchanged.
 */
export async function lockJournalCashForGlReversal(companyId: string, journalEntryId: string): Promise<string[]> {
  const locked = await refuseJournalCashOfCompletedReconciliation(companyId, journalEntryId);
  if (locked.length === 0) return locked;
  const rootId = (await findJournalChainRoot(companyId, journalEntryId)) ?? journalEntryId;
  const lines = (await sql`
    SELECT id, amount, auto_post_run_id FROM bank_transactions
    WHERE id = ANY(${locked}::UUID[]) AND company_id = ${companyId}::UUID
  `) as DbRow[];
  for (const line of lines) {
    const facts = await allocationFacts(companyId, line, rootId);
    if (facts && await armEnforced(companyId, facts.arm)) {
      throw new BankControlError('REVERSE_FROM_BANK_LINE',
        `This journal is a bank allocation, and while ${armLabel(facts.arm)} approval is on it is reversed from its bank `
        + 'line, not from Journal Entries: open the bank line in Banking and reverse it there.');
    }
  }
  return locked;
}

/**
 * A document's own void, cancel or reversal (supplier payment void, receipt or
 * refund cancel, batch reversal) whose journal a statement line is MATCHED to:
 * by round 1's rule a journal a live bank line books is a bank allocation, so
 * each matched line (`bankLineIds`, locked by the caller's leg) is judged
 * exactly as the bank line's own reverse judges it (assertMayReverse), before
 * the reversal writes. Returns the audit to write once it is done; a no-op when
 * nothing is matched, the arm is ungated (money in) or not enforced.
 */
export async function assertMayReverseMatchedLeg(
  companyId: string, rootId: string, bankLineIds: readonly string[], actorUserId: string,
): Promise<() => Promise<void>> {
  if (bankLineIds.length === 0) return async () => undefined;
  const lines = (await sql`
    SELECT id, amount, auto_post_run_id FROM bank_transactions
    WHERE id = ANY(${[...bankLineIds]}::UUID[]) AND company_id = ${companyId}::UUID ORDER BY id
  `) as DbRow[];
  const cleared: { id: string; clearance: ReversalClearance | null }[] = [];
  for (const line of lines) cleared.push({ id: String(line.id), clearance: await assertMayReverse(companyId, line, rootId, actorUserId) });
  return async () => { for (const c of cleared) await auditedReversal(companyId, c.id, actorUserId, c.clearance, null); };
}

/** A refusal this request's session gets for `action`, or null: a person in their own session. */
async function sessionRefusal(action: string): Promise<BankControlError | null> {
  try {
    await assertHumanSession(action);
    return null;
  } catch (err) {
    if (err instanceof BankControlError) return err;
    throw err;
  }
}

/**
 * The MCP reverse tools' pre-check, before any write and before a dry run
 * answers: an agent may not reverse an allocation whose arm's type is
 * enforced. Unlocked reads; the choke point re-decides under the lock.
 */
export async function agentReversalRefusal(companyId: string, bankTxIds: readonly string[]): Promise<BankControlError | null> {
  if (bankTxIds.length === 0) return null;
  const enforced = { manual_journal: await armEnforced(companyId, 'manual_journal'),
    supplier_payment: await armEnforced(companyId, 'supplier_payment') };
  if (!enforced.manual_journal && !enforced.supplier_payment) return null;
  const refusal = await sessionRefusal(ACTION);
  if (!refusal) return null;
  for (const id of bankTxIds) {
    const [line] = (await sql`
      SELECT amount, auto_post_run_id FROM bank_transactions WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    const chain = line ? await peekLineChain(companyId, id) : null;
    const facts = line ? await allocationFacts(companyId, line, chain?.rootId ?? null) : null;
    if (facts && enforced[facts.arm]) return refusal;
  }
  return null;
}

/**
 * undoRun / undoAnyway, judged at the RUN level before any row: a run posts
 * account journals (auto-post gate), so under manual_journal enforcement only
 * a person may undo it, and not the person who ran it (its `created_by`)
 * unless sole on the admin floor; an import's run (the zero uuid) is nobody's.
 * Null when not enforced; otherwise the clearance to audit (`auditRunUndo`).
 */
export async function assertMayUndoRun(companyId: string, runId: string, actorUserId: string): Promise<ReversalClearance | null> {
  if (!(await armEnforced(companyId, 'manual_journal'))) return null;
  await assertHumanSession('undo an auto-post run while approval is on');
  const [run] = (await sql`
    SELECT created_by::TEXT AS created_by FROM bank_auto_post_runs WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const by = run?.created_by != null && String(run.created_by) !== NOBODY ? String(run.created_by) : null;
  const own = by !== null && sameUser(by, actorUserId);
  const soleApprover = own && await isSoleAsCaller(companyId, actorUserId);
  if (own && !soleApprover) {
    throw new BankControlError('ALLOCATOR_MAY_NOT_REVERSE',
      'You ran this auto-post run, so while manual-journal approval is on you cannot undo it yourself. '
      + 'Ask another member to undo it.');
  }
  return { arm: 'manual_journal', allocators: by ? [by] : [], soleApprover };
}

/** The audit row of a run undo `assertMayUndoRun` cleared, once something was undone. */
export async function auditRunUndo(
  companyId: string, runId: string, actorUserId: string, clearance: ReversalClearance | null, undone: number,
): Promise<void> {
  if (!clearance || undone === 0) return;
  await logAuditOrThrow({
    companyId, userId: actorUserId, action: 'reverse', entityType: 'bank_auto_post_run', entityId: runId,
    changes: { fields: [], metadata: {
      allocator: clearance.allocators.join(','), armType: clearance.arm, soleApprover: String(clearance.soleApprover),
      undone: String(undone),
    } },
  });
}
