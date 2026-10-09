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
import { armEnforced, armLabel, importerArmOf, isSoleAsCaller, type BankArm } from './bankLineImporterGate';
import { peekLineChain } from './bankChainLineReversal';

const NOBODY = '00000000-0000-0000-0000-000000000000';
const ACTION = 'reverse a bank allocation while approval is on';

/** What a permitted reversal under enforcement records. */
export interface ReversalClearance { arm: BankArm; allocators: string[]; soleApprover: boolean }

/** The arm of the allocation behind `line` (matched to chain root `rootId`) and who made it; null when ungated. */
async function reversalFacts(companyId: string, line: DbRow, rootId: string | null): Promise<{ arm: BankArm; allocators: string[] } | null> {
  if (!rootId) return null;
  const [row] = (await sql`
    SELECT (SELECT created_by::TEXT FROM gl_journal_entries WHERE id = ${rootId}::UUID AND company_id = ${companyId}::UUID) AS journal_by,
           (SELECT created_by::TEXT FROM bank_auto_post_runs
             WHERE id = ${line.auto_post_run_id == null ? null : String(line.auto_post_run_id)}::UUID
               AND company_id = ${companyId}::UUID) AS run_by,
           doc.kind, doc.created_by AS doc_by
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT 'supplier' AS kind, created_by::TEXT AS created_by FROM supplier_payment_batches
        WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${rootId}::UUID
      UNION ALL SELECT 'supplier', created_by::TEXT FROM supplier_payments
        WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${rootId}::UUID
      UNION ALL SELECT 'customer', created_by::TEXT FROM customer_payments
        WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${rootId}::UUID
      LIMIT 1
    ) doc ON true
  `) as DbRow[];
  // The allocation side's one mapping: a document is a contact; a plain journal is the account arm.
  const arm = row?.kind ? importerArmOf(String(row.kind), 'document', Number(line.amount)) : 'manual_journal';
  if (!arm) return null; // money in: a receipt, a supplier refund
  const allocators = [...new Set([row?.journal_by, row?.doc_by, row?.run_by]
    .filter((id): id is string => typeof id === 'string' && id !== NOBODY))];
  return { arm, allocators };
}

/**
 * The choke point's check (reverseReconciledTransaction): `line` locked, its
 * own refusals passed, nothing written yet. Null when the arm is ungated or not
 * enforced (nothing to audit); otherwise the clearance to audit once the
 * reversal is done. Throws the BankControlError refusals.
 */
export async function assertMayReverse(
  companyId: string, line: DbRow, rootId: string | null, actorUserId: string,
): Promise<ReversalClearance | null> {
  const facts = await reversalFacts(companyId, line, rootId);
  if (!facts || !(await armEnforced(companyId, facts.arm))) return null;
  await assertHumanSession(ACTION);
  const own = facts.allocators.includes(actorUserId);
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
    const facts = line ? await reversalFacts(companyId, line, chain?.rootId ?? null) : null;
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
  const soleApprover = by === actorUserId && await isSoleAsCaller(companyId, actorUserId);
  if (by === actorUserId && !soleApprover) {
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
