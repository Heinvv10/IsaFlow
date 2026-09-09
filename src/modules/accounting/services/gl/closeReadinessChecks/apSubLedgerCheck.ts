/**
 * AP sub-ledger to GL control account close-readiness check.
 *
 * Compares open supplier invoice balances (sub-ledger) against the posted
 * payable GL control account balance.
 *
 * AP_OPEN_STATUSES = ['approved', 'partially_paid']
 * Canonical set per src/lib/constants/invoiceStatuses.ts.
 * Note: supplier_invoices do NOT use an 'overdue' status — past-due invoices
 * remain 'approved' in this system (see AP_OPEN_STATUSES comment).
 *
 * account_subtype = 'payable' is the canonical seeded value
 * (see migrations 204, 254 and migrationValidationService.ts).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';
import { documentInLedgerAsAtFragment } from '../../shared/softDeleteLedgerPresence';

type Row = DbRow;

/** Amounts within this tolerance (ZAR) are treated as equal. */
const SUB_LEDGER_TOLERANCE = 0.01;

/** Difference above this threshold (ZAR) escalates from warn to fail. */
export const SUB_LEDGER_FAIL_THRESHOLD = 100;

export async function apSubLedgerCheck(
  companyId: string,
  period: { endDate: string },
): Promise<ChecklistItem> {
  // AP sub-ledger: sum of open supplier invoice balances as of period end.
  // Uses canonical AP_OPEN_STATUSES = ['approved', 'partially_paid'].
  // 'overdue' is intentionally excluded — supplier invoices don't use that status.
  const invRows = (await sql`
    SELECT COALESCE(SUM(si.balance), 0) AS ap_total
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID
      AND si.status IN ('approved', 'partially_paid')
      -- K-053: same rule as arSubLedgerCheck — a soft-deleted bill stays on
      -- this side only while its journal is still standing on the other one AS
      -- AT the period end, which is the date the GL half below is bounded by.
      AND ${documentInLedgerAsAtFragment('si', period.endDate, companyId)}
      AND si.invoice_date <= ${period.endDate}::date
  `) as Row[];

  // GL control account: net credit balance from posted payable lines.
  // account_subtype = 'payable' is canonical (migrations 204 + 254).
  const glRows = (await sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS gl_balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_subtype = 'payable'
      AND je.entry_date <= ${period.endDate}::date
  `) as Row[];

  const apTotal = Number(invRows[0]?.ap_total ?? 0);
  const glBalance = Number(glRows[0]?.gl_balance ?? 0);
  const diff = Math.abs(apTotal - glBalance);

  if (diff <= SUB_LEDGER_TOLERANCE) {
    return {
      key: 'ap_ties',
      label: 'AP sub-ledger ties to GL',
      status: 'pass',
      reason: `AP sub-ledger (R${apTotal.toFixed(2)}) matches GL payable control account.`,
      fixHref: '/accounting/supplier-invoices',
    };
  }

  return {
    key: 'ap_ties',
    label: 'AP sub-ledger ties to GL',
    status: diff > SUB_LEDGER_FAIL_THRESHOLD ? 'fail' : 'warn',
    reason: `AP sub-ledger R${apTotal.toFixed(2)} vs GL payable R${glBalance.toFixed(2)} — difference R${diff.toFixed(2)}.`,
    fixHref: '/accounting/supplier-invoices',
  };
}
