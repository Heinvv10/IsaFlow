/**
 * AR sub-ledger to GL control account close-readiness check.
 *
 * Compares open customer invoice balances (sub-ledger) against the posted
 * receivable GL control account balance.
 *
 * AR_OPEN_STATUSES = ['approved', 'sent', 'partially_paid', 'overdue']
 * Canonical set per src/lib/constants/invoiceStatuses.ts and debtorsManagerService.
 *
 * account_subtype = 'receivable' is the canonical seeded value
 * (see migrations 204, 254 and migrationValidationService.ts).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';
import { documentInLedgerAsAt } from '../../shared/softDeleteLedgerPresence';

type Row = DbRow;

/** Amounts within this tolerance (ZAR) are treated as equal. */
const SUB_LEDGER_TOLERANCE = 0.01;

/** Difference above this threshold (ZAR) escalates from warn to fail. */
export const SUB_LEDGER_FAIL_THRESHOLD = 100;

export async function arSubLedgerCheck(
  companyId: string,
  period: { endDate: string },
): Promise<ChecklistItem> {
  // AR sub-ledger: sum of open customer invoice balances as of period end.
  // Uses canonical AR_OPEN_STATUSES; 'sent' is required — invoices emailed but
  // unpaid are outstanding and must be included.
  const invRows = (await sql`
    SELECT COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)), 0) AS ar_total
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID
      AND ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
      -- K-053: a soft-deleted invoice belongs on this side of the comparison
      -- exactly when it is still on the OTHER side, AS AT THE SAME DATE. The
      -- GL half below is bounded by entry_date <= endDate, and the delete's
      -- reversal is dated TODAY whenever the invoice's own period is closed,
      -- so an undated exclusion here fails the check by the whole document
      -- amount for every period between the invoice and the delete. The
      -- reversal-chain parity in shared/softDeleteLedgerPresence answers the
      -- dated question, and covers documents deleted BEFORE this change (whose
      -- journal is still standing) with no historical repair.
      AND ${documentInLedgerAsAt('ci', period.endDate, companyId)}
      AND ci.invoice_date <= ${period.endDate}::date
  `) as Row[];

  // GL control account: net debit balance from posted receivable lines.
  // account_subtype = 'receivable' is canonical (migrations 204 + 254).
  const glRows = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS gl_balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_subtype = 'receivable'
      AND je.entry_date <= ${period.endDate}::date
  `) as Row[];

  const arTotal = Number(invRows[0]?.ar_total ?? 0);
  const glBalance = Number(glRows[0]?.gl_balance ?? 0);
  const diff = Math.abs(arTotal - glBalance);

  if (diff <= SUB_LEDGER_TOLERANCE) {
    return {
      key: 'ar_ties',
      label: 'AR sub-ledger ties to GL',
      status: 'pass',
      reason: `AR sub-ledger (R${arTotal.toFixed(2)}) matches GL receivable control account.`,
      fixHref: '/accounting/customer-invoices',
    };
  }

  return {
    key: 'ar_ties',
    label: 'AR sub-ledger ties to GL',
    status: diff > SUB_LEDGER_FAIL_THRESHOLD ? 'fail' : 'warn',
    reason: `AR sub-ledger R${arTotal.toFixed(2)} vs GL receivable R${glBalance.toFixed(2)} — difference R${diff.toFixed(2)}.`,
    fixHref: '/accounting/customer-invoices',
  };
}
