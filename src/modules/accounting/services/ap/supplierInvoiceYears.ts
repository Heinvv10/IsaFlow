/**
 * The years each bill of the supplier-invoice bulk action can post a journal in — its ordered-lazy prediction
 * (core/numberYearLocks.ts). Exact on the low side: no journal of a bill is dated below its set's min.
 *
 *   - approve (draft / pending_approval): the bill's date; and when that date sits in a filed VAT period (the route
 *     opts in to the s16(3) late claim) the companion's claim date (lateClaimDate over the active locks, as
 *     planLockedVatPosting dates it — brk-numrace M2) and the R-127 provisional settlement's reclass, dated on the
 *     evidenced provisional journal (provisionalSettlementClaim, brk-numrace N2);
 *   - post_gl (approved, no journal yet): the bill's date;
 *   - cancel: only a bill that HAS a journal posts a reversal (gl/journalReversalYears, companion included); a draft
 *     reverses nothing and has no years (brk-numrace M4).
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { journalYearOf } from '../core/numberYearLocks';
import { predictReversalYears } from '../gl/journalReversalYears';
import { lateClaimDate } from '../gl/vatLateClaimRules';

type Row = Record<string, unknown>;
export type SupplierBulkAction = 'approve' | 'cancel' | 'post_gl';

export async function predictSupplierBillYears(
  companyId: string,
  invoiceIds: readonly string[],
  action: SupplierBulkAction,
): Promise<Map<string, number[]>> {
  const rows = (await sql`
    SELECT id, invoice_date, status, gl_journal_entry_id FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND id = ANY(${invoiceIds as string[]}::UUID[]) AND deleted_at IS NULL
  `) as Row[];
  const out = new Map<string, number[]>();
  if (action === 'cancel') {
    const reversed = await predictReversalYears(companyId,
      rows.flatMap((r) => (r.gl_journal_entry_id ? [String(r.gl_journal_entry_id)] : [])));
    for (const r of rows) if (r.gl_journal_entry_id) out.set(String(r.id), reversed.get(String(r.gl_journal_entry_id)) ?? []);
    return out;
  }
  if (action === 'post_gl') {
    for (const r of rows) {
      if (String(r.status) === 'approved' && !r.gl_journal_entry_id) out.set(String(r.id), [journalYearOf(fmtDate(r.invoice_date))]);
    }
    return out;
  }
  const locks = ((await sql`
    SELECT period_start, period_end FROM vat_period_locks WHERE company_id = ${companyId}::UUID AND unlocked_at IS NULL
  `) as Row[]).map((r) => ({ periodStart: fmtDate(r.period_start), periodEnd: fmtDate(r.period_end) }));
  const provisional = (await sql`
    SELECT si.id AS bill, je.entry_date FROM supplier_invoices si
    JOIN gl_journal_entries je ON je.company_id = si.company_id AND je.source_document_id = si.source_document_id
      AND je.status = 'posted'
    JOIN bank_transactions bt ON bt.provisional_je_id = je.id AND bt.company_id = je.company_id
    WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${invoiceIds as string[]}::UUID[])
  `) as Row[];
  for (const r of rows) {
    if (String(r.status) !== 'draft' && String(r.status) !== 'pending_approval') continue;
    const date = fmtDate(r.invoice_date);
    const years = [journalYearOf(date)];
    if (locks.some((l) => l.periodStart <= date && l.periodEnd >= date)) {
      years.push(journalYearOf(lateClaimDate(date, locks)));
      for (const p of provisional) if (String(p.bill) === String(r.id)) years.push(journalYearOf(fmtDate(p.entry_date)));
    }
    out.set(String(r.id), years);
  }
  return out;
}
