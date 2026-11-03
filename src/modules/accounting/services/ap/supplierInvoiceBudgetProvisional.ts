/**
 * A bill raised from a slip a bank-first provisional journal already expensed (R-127) costs the
 * budget NOTHING more when approved: approving posts the bill's expense AND reclasses the
 * provisional's expense/VAT lines to AP (credits them, dated `reclassDate`). So the budget check
 * counts the bill's lines PLUS those reclass credits, as negative lines on the provisional's own
 * accounts and dimensions, in the reclass month (P5-2 review B1). Without them the provisional's
 * amount, already in actuals, was counted a second time.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { journalStandsFragment } from '../shared/journalInForceAsAt';
import type { DocumentLine } from '../budgets/budgetCheckCore';
import type { ProvisionalClaim } from './provisionalSettlementClaim';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The reclass a claimed provisional will post, as budget lines (credits: negative). */
export function provisionalReclassLines(claim: ProvisionalClaim | null | undefined): DocumentLine[] {
  if (!claim) return [];
  const month = fmtDate(claim.reclassDate).slice(0, 7);
  return claim.settleLines.map((l) => ({
    glAccountId: l.glAccountId, cc1Id: l.cc1Id ?? null, cc2Id: l.cc2Id ?? null, buId: l.buId ?? null,
    amount: round2(-((l.debit || 0) - (l.credit || 0))), month,
  }));
}

/**
 * The same lines for a PREVIEW, read without the claim's locks or refusals: the standing, evidenced,
 * unsettled provisional behind the bill's slip, if any. The month is the bill's: the claim moves the
 * reclass to the provisional's date only when the bill's VAT period is filed (approve decides that).
 */
export async function peekProvisionalReclassLines(companyId: string, invoiceId: string, billMonth: string): Promise<DocumentLine[]> {
  const [je] = (await sql`
    SELECT je.id, bt.bank_account_id
      FROM supplier_invoices si
      JOIN gl_journal_entries je ON je.company_id = si.company_id AND je.source_document_id = si.source_document_id
      JOIN bank_transactions bt ON bt.provisional_je_id = je.id AND bt.company_id = je.company_id AND bt.status IN ('matched', 'reconciled')
     WHERE si.id = ${invoiceId}::UUID AND si.company_id = ${companyId}::UUID
       AND je.status = 'posted' AND je.needs_evidence = false AND ${journalStandsFragment('je.id', companyId)}
       AND NOT EXISTS (SELECT 1 FROM supplier_payments sp WHERE sp.company_id = je.company_id
                        AND sp.settles_provisional_je_id = je.id AND sp.status <> 'cancelled')
     ORDER BY je.id LIMIT 1
  `) as DbRow[];
  if (!je) return [];
  const rows = (await sql`
    SELECT gl_account_id::TEXT AS gl_account_id, cc1_id::TEXT AS cc1_id, cc2_id::TEXT AS cc2_id, bu_id::TEXT AS bu_id,
           (debit - credit)::TEXT AS net
      FROM gl_journal_lines
     WHERE journal_entry_id = ${String(je.id)}::UUID AND company_id = ${companyId}::UUID AND gl_account_id <> ${String(je.bank_account_id)}::UUID
  `) as DbRow[];
  return rows.map((r) => ({
    glAccountId: String(r.gl_account_id), cc1Id: r.cc1_id ? String(r.cc1_id) : null, cc2Id: r.cc2_id ? String(r.cc2_id) : null,
    buId: r.bu_id ? String(r.bu_id) : null, amount: round2(-Number(r.net)), month: billMonth,
  }));
}
