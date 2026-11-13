/**
 * The write-side checks of a reallocation (bankReallocationService), split out for the file-size cap: the period the
 * original date sits in, putting the line back to 'reconciled' with its review stamp, proving the bank side did not
 * move, and naming the document the new allocation created. Every throw here is inside the service's savepoint (or
 * before it), so a refusal leaves nothing written.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { assertReversalDatePostable } from './reversalDatePostable';
import {
  BankReallocationRefusal, type OldJournalLine, type ReallocationPlan, type ReallocationTarget,
} from './bankReallocationGuards';

/**
 * Both journals carry the ORIGINAL entry date, or nothing is written: a rolled date would move the bank GL balance
 * as at the statement date a completed reconciliation signed off. A closed (or locked) or missing period refuses; a
 * VAT-locked date refuses for the contra here (an explicit date refuses rather than rolls,
 * journalEntryReversalDate) and for the new journal in createJournalEntry's central guard.
 */
export async function assertOriginalDateKept(companyId: string, journalId: string, entryDate: string): Promise<void> {
  const status = await getPeriodStatusForDate(companyId, entryDate);
  if (status !== 'open') {
    throw new BankReallocationRefusal(`The fiscal period covering ${entryDate} is ${status === 'no_period'
      ? 'missing' : 'closed or locked'}. A reallocation keeps the original date and never moves it: re-open the `
      + 'period first.');
  }
  await assertReversalDatePostable(companyId, journalId, entryDate);
}

export interface BankLegNow { journalId: string; lineId: string; glAccountId: string; debit: number; credit: number; entryDate: string }

/** The journal line the statement line is matched to now, with its journal's date. */
export async function readBankLeg(companyId: string, bankTxId: string): Promise<BankLegNow | null> {
  const [r] = (await sql`
    SELECT jl.id::TEXT AS line_id, jl.journal_entry_id::TEXT AS je, jl.gl_account_id::TEXT AS account,
           jl.debit::float8 AS debit, jl.credit::float8 AS credit, je.entry_date
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = bt.company_id
    WHERE bt.id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID AND je.status = 'posted'`) as DbRow[];
  if (!r) return null;
  return {
    journalId: String(r.je), lineId: String(r.line_id), glAccountId: String(r.account),
    debit: Number(r.debit), credit: Number(r.credit), entryDate: fmtDate(r.entry_date as string | Date),
  };
}

/** The bank side is what it was: same account, same amount and direction, same date, on the new journal. */
export function assertBankLegKept(old: OldJournalLine, entryDate: string, now: BankLegNow | null, newJournalId: string): BankLegNow {
  const cents = (n: number) => Math.round(n * 100);
  if (!now || now.journalId !== newJournalId || now.glAccountId !== old.glAccountId || now.entryDate !== entryDate
    || cents(now.debit) !== cents(old.debit) || cents(now.credit) !== cents(old.credit)) {
    throw new BankReallocationRefusal('The new allocation would change this line\'s bank side; nothing was written. '
      + 'Contact support.');
  }
  return now;
}

/**
 * Back to 'reconciled' on its own reconciliation, matched to the new bank leg, with the ORIGINAL review stamp (Hein:
 * keep the reviewer). Migration 981's trigger cleared it when allocateTransaction moved matched_journal_line_id; this
 * UPDATE leaves the link alone, so the trigger keeps the stamp written here. The auto-post run tag is cleared: the
 * line's journal is no longer the run's posting, and an undo of that run must not reverse the new one (the audit row
 * records the run id).
 */
export async function restoreReconciled(
  companyId: string, bankTxId: string, reconciliationId: string, newLineId: string,
  reviewed: { at: unknown; by: unknown },
): Promise<void> {
  const rows = (await sql`
    UPDATE bank_transactions
    SET status = 'reconciled', reviewed_at = ${reviewed.at ?? null}::TIMESTAMPTZ,
        reviewed_by = ${reviewed.by == null ? null : String(reviewed.by)}::UUID, auto_post_run_id = NULL,
        updated_at = NOW()
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
      AND reconciliation_id = ${reconciliationId}::UUID AND matched_journal_line_id = ${newLineId}::UUID
      AND status = 'allocated'
    RETURNING id`) as DbRow[];
  if (rows.length !== 1) {
    throw new BankReallocationRefusal('This bank line changed while it was being reallocated; nothing was written. '
      + 'Retry in a moment.');
  }
}

export type NewDocumentKind = 'none' | 'supplier_payment' | 'supplier_refund' | 'customer_receipt' | 'customer_refund';

/** The payment / receipt / refund the new allocation created on its journal (account targets create none). */
export async function newDocumentOf(
  companyId: string, journalId: string, target: ReallocationTarget, spent: boolean,
): Promise<{ kind: NewDocumentKind; paymentId: string | null }> {
  if (target.kind === 'account') return { kind: 'none', paymentId: null };
  const kind: NewDocumentKind = target.kind === 'supplier'
    ? (spent ? 'supplier_payment' : 'supplier_refund') : (spent ? 'customer_refund' : 'customer_receipt');
  const [r] = (target.kind === 'supplier'
    ? await sql`SELECT id::TEXT AS id FROM supplier_payments
        WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID AND status <> 'cancelled' LIMIT 1`
    : await sql`SELECT id::TEXT AS id FROM customer_payments
        WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID AND status <> 'cancelled' LIMIT 1`
  ) as DbRow[];
  return { kind, paymentId: r ? String(r.id) : null };
}

const stamp = (v: unknown): string => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v));

/**
 * The audit row of a reallocation (audit_log's CHECK has no 'reallocate' action: an `update` with
 * `operation: reallocate`). It carries the ORIGINAL review stamp, so the restored stamp is told apart from a fresh
 * review, and the auto-post run the line left. A dry run writes it too (rolled back with everything) and logs as one.
 */
export async function auditReallocation(a: {
  companyId: string; userId: string; bankTxId: string; target: ReallocationTarget; plan: ReallocationPlan;
  reviewed: { at: unknown; by: unknown }; autoPostRunId: string | null; newLineId: string; newJournalEntryId: string;
  reversalJournalEntryId: string; postingAgent: string; dryRun: boolean;
}): Promise<void> {
  const t = a.target;
  await logAuditOrThrow({
    companyId: a.companyId, userId: a.userId, action: 'update', entityType: 'bank_transaction', entityId: a.bankTxId,
    changes: {
      fields: [{ field: 'matched_journal_line_id', old: a.plan.bankLeg.lineId, new: a.newLineId, label: 'Allocation journal line' }],
      metadata: {
        operation: 'reallocate', reconciliationId: a.plan.reconciliationId, originalJournalEntryId: a.plan.journalId,
        reversalJournalEntryId: a.reversalJournalEntryId, newJournalEntryId: a.newJournalEntryId, targetKind: t.kind,
        targetId: t.kind === 'account' ? t.glAccountId : t.kind === 'supplier' ? t.supplierId : t.customerId,
        entryDate: a.plan.entryDate, postingAgent: a.postingAgent,
        originalReviewedAt: stamp(a.reviewed.at), originalReviewedBy: stamp(a.reviewed.by),
        clearedAutoPostRunId: a.autoPostRunId ?? '',
      },
    },
  });
  log.info(a.dryRun ? 'Reallocation dry run (rolled back)' : 'Reallocated reconciled bank transaction', {
    companyId: a.companyId, bankTxId: a.bankTxId, reconciliationId: a.plan.reconciliationId,
    originalJournalEntryId: a.plan.journalId, newJournalEntryId: a.newJournalEntryId,
    reversalJournalEntryId: a.reversalJournalEntryId, dryRun: a.dryRun,
  }, 'accounting');
}
