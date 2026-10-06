/**
 * The supplier-invoice bulk action's up-front year lock (core/numberYearLocks.ts): every year a journal of the run
 * can be dated in, ascending, after claiming the bills in walk order with approve's / cancel's own lock
 * (lockSupplierInvoiceForUpdate: FOR UPDATE, 5 s) — rows, then years (brk-numrace M3).
 *
 *   - approve (draft / pending_approval): the bill's date, and — the route opts in to the s16(3) late claim — when
 *     that date sits in a filed VAT period, the companion's claim date (lateClaimDate over the active locks, the
 *     function planLockedVatPosting dates it with; brk-numrace M2);
 *   - post_gl (approved, no journal yet): the bill's date;
 *   - cancel: only a bill that HAS a journal posts a reversal (gl/journalReversalYears, companion included); a draft
 *     reverses nothing and takes no key (brk-numrace M4).
 * A bill no action will post for contributes nothing, so a run of drafts to cancel takes no key at all.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { claimRowsThenLockYears, journalYearOf } from '../core/numberYearLocks';
import { predictReversalYears } from '../gl/journalReversalYears';
import { lateClaimDate } from '../gl/vatLateClaimRules';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';

type Row = Record<string, unknown>;
export type SupplierBulkAction = 'approve' | 'cancel' | 'post_gl';

export async function lockSupplierInvoiceYears(
  companyId: string,
  invoiceIds: readonly string[],
  action: SupplierBulkAction,
): Promise<void> {
  const rows = (await sql`
    SELECT id, invoice_date, status, gl_journal_entry_id FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND id = ANY(${invoiceIds as string[]}::UUID[]) AND deleted_at IS NULL
  `) as Row[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const locks = action === 'approve' ? ((await sql`
    SELECT period_start, period_end FROM vat_period_locks WHERE company_id = ${companyId}::UUID AND unlocked_at IS NULL
  `) as Row[]).map((r) => ({ periodStart: fmtDate(r.period_start), periodEnd: fmtDate(r.period_end) })) : [];

  const yearsOf = (r: Row | undefined): number[] => {
    if (!r) return [];
    const date = fmtDate(r.invoice_date);
    const status = String(r.status);
    if (action === 'post_gl') return status === 'approved' && !r.gl_journal_entry_id ? [journalYearOf(date)] : [];
    if (action !== 'approve' || (status !== 'draft' && status !== 'pending_approval')) return [];
    const locked = locks.some((l) => l.periodStart <= date && l.periodEnd >= date);
    return [journalYearOf(date), ...(locked ? [journalYearOf(lateClaimDate(date, locks))] : [])];
  };
  const reversed = action === 'cancel'
    ? await predictReversalYears(companyId, rows.flatMap((r) => (r.gl_journal_entry_id ? [String(r.gl_journal_entry_id)] : [])))
    : [];
  await claimRowsThenLockYears(companyId, invoiceIds.map((id) => ({ id, years: yearsOf(byId.get(id)) })),
    (id) => lockSupplierInvoiceForUpdate(companyId, id), reversed);
}
