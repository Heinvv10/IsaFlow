/**
 * Period Close Readiness Service
 *
 * Runs 6 parallel checks to determine whether a fiscal period is ready to close:
 *   1. bank_reconciled   — all bank txns in period are status='matched' or 'excluded'
 *   2. unposted_journals — all journal entries in period are posted
 *   3. ar_ties           — AR sub-ledger total ties to GL receivable control account
 *   4. ap_ties           — AP sub-ledger total ties to GL payable control account
 *   5. vat_reviewed      — a VAT return has been submitted covering this period
 *   6. tb_balanced       — sum(debits) == sum(credits) for posted entries
 *
 * All checks are ADVISORY — they do not block period close.
 * Every SQL query is scoped by company_id (multi-tenant safe).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalPeriodById } from './fiscalPeriodService';

type Row = DbRow;

export type ChecklistItemStatus = 'pass' | 'fail' | 'warn';

export type ChecklistItemKey =
  | 'bank_reconciled'
  | 'unposted_journals'
  | 'ar_ties'
  | 'ap_ties'
  | 'vat_reviewed'
  | 'tb_balanced';

export interface ChecklistItem {
  key: ChecklistItemKey;
  label: string;
  status: ChecklistItemStatus;
  reason: string;
  fixHref: string;
}

export interface CloseReadiness {
  periodId: string;
  periodLabel: string;
  items: ChecklistItem[];
  overallStatus: ChecklistItemStatus;
}

const SUB_LEDGER_TOLERANCE = 0.01;

// ── Individual checks ────────────────────────────────────────────────────────

async function checkBankReconciled(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT COUNT(*) AS unreconciled_count
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND transaction_date >= ${startDate}::date
      AND transaction_date <= ${endDate}::date
      AND status NOT IN ('matched', 'excluded')
  `) as Row[];

  const count = Number(rows[0]?.unreconciled_count ?? 0);

  if (count === 0) {
    return {
      key: 'bank_reconciled',
      label: 'Bank reconciled',
      status: 'pass',
      reason: 'All bank transactions in this period are matched or excluded.',
      fixHref: '/accounting/bank-transactions',
    };
  }

  return {
    key: 'bank_reconciled',
    label: 'Bank reconciled',
    status: 'fail',
    reason: `${count} unreconciled bank transaction${count === 1 ? '' : 's'} remain in this period.`,
    fixHref: '/accounting/bank-transactions',
  };
}

async function checkUnpostedJournals(
  companyId: string,
  periodId: string,
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT COUNT(*) AS draft_count
    FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND fiscal_period_id = ${periodId}::UUID
      AND status != 'posted'
  `) as Row[];

  const count = Number(rows[0]?.draft_count ?? 0);

  if (count === 0) {
    return {
      key: 'unposted_journals',
      label: 'Unposted journals',
      status: 'pass',
      reason: 'All journal entries in this period are posted.',
      fixHref: '/accounting/journal-entries',
    };
  }

  return {
    key: 'unposted_journals',
    label: 'Unposted journals',
    status: 'fail',
    reason: `${count} unposted journal entr${count === 1 ? 'y' : 'ies'} in this period.`,
    fixHref: '/accounting/journal-entries?filter=draft',
  };
}

async function checkARTies(
  companyId: string,
  endDate: string,
): Promise<ChecklistItem> {
  // AR sub-ledger: open customer invoice balances as of period end
  const invRows = (await sql`
    SELECT COALESCE(SUM(ci.total_amount - ci.amount_paid), 0) AS ar_total
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID
      AND ci.status IN ('approved', 'partially_paid', 'overdue')
      AND ci.invoice_date <= ${endDate}::date
  `) as Row[];

  // GL control account: receivable balance from posted journal lines
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
      AND je.entry_date <= ${endDate}::date
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
    status: diff > 100 ? 'fail' : 'warn',
    reason: `AR sub-ledger R${arTotal.toFixed(2)} vs GL receivable R${glBalance.toFixed(2)} — difference R${diff.toFixed(2)}.`,
    fixHref: '/accounting/customer-invoices',
  };
}

async function checkAPTies(
  companyId: string,
  endDate: string,
): Promise<ChecklistItem> {
  // AP sub-ledger: open supplier invoice balances as of period end
  const invRows = (await sql`
    SELECT COALESCE(SUM(si.balance), 0) AS ap_total
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID
      AND si.status IN ('approved', 'partially_paid', 'overdue')
      AND si.invoice_date <= ${endDate}::date
  `) as Row[];

  // GL control account: payable balance from posted journal lines
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
      AND je.entry_date <= ${endDate}::date
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
    status: diff > 100 ? 'fail' : 'warn',
    reason: `AP sub-ledger R${apTotal.toFixed(2)} vs GL payable R${glBalance.toFixed(2)} — difference R${diff.toFixed(2)}.`,
    fixHref: '/accounting/supplier-invoices',
  };
}

async function checkVATReviewed(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<ChecklistItem> {
  // A VAT return is considered reviewed if a vat_returns record exists whose
  // period overlaps with this fiscal period.
  const rows = (await sql`
    SELECT COUNT(*) AS vat_count
    FROM vat_returns
    WHERE company_id = ${companyId}::UUID
      AND period_start <= ${endDate}::date
      AND period_end >= ${startDate}::date
  `) as Row[];

  const count = Number(rows[0]?.vat_count ?? 0);

  if (count > 0) {
    return {
      key: 'vat_reviewed',
      label: 'VAT reviewed',
      status: 'pass',
      reason: 'At least one VAT return has been submitted covering this period.',
      fixHref: '/accounting/reports/vat-return',
    };
  }

  return {
    key: 'vat_reviewed',
    label: 'VAT reviewed',
    status: 'warn',
    reason: 'No VAT return has been submitted for this period yet.',
    fixHref: '/accounting/reports/vat-return',
  };
}

async function checkTBBalanced(
  companyId: string,
  periodId: string,
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(jl.debit), 0)  AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.fiscal_period_id = ${periodId}::UUID
      AND je.status = 'posted'
  `) as Row[];

  const totalDebit = Number(rows[0]?.total_debit ?? 0);
  const totalCredit = Number(rows[0]?.total_credit ?? 0);
  const diff = Math.abs(totalDebit - totalCredit);

  if (diff <= 0.01) {
    return {
      key: 'tb_balanced',
      label: 'Trial balance balanced',
      status: 'pass',
      reason: `Debits and credits both equal R${totalDebit.toFixed(2)}.`,
      fixHref: '/accounting/trial-balance',
    };
  }

  return {
    key: 'tb_balanced',
    label: 'Trial balance balanced',
    status: 'fail',
    reason: `Debits R${totalDebit.toFixed(2)} do not equal credits R${totalCredit.toFixed(2)} — diff R${diff.toFixed(2)}.`,
    fixHref: '/accounting/trial-balance',
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function aggregateStatus(items: ChecklistItem[]): ChecklistItemStatus {
  if (items.some(i => i.status === 'fail')) return 'fail';
  if (items.some(i => i.status === 'warn')) return 'warn';
  return 'pass';
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getCloseReadiness(
  companyId: string,
  periodId: string,
): Promise<CloseReadiness | null> {
  const period = await getFiscalPeriodById(companyId, periodId);
  if (!period) return null;

  const { startDate, endDate, periodName } = period;

  log.info('Running close-readiness checks', { companyId, periodId }, 'accounting');

  const [bankItem, journalItem, arItem, apItem, vatItem, tbItem] = await Promise.all([
    checkBankReconciled(companyId, startDate, endDate),
    checkUnpostedJournals(companyId, periodId),
    checkARTies(companyId, endDate),
    checkAPTies(companyId, endDate),
    checkVATReviewed(companyId, startDate, endDate),
    checkTBBalanced(companyId, periodId),
  ]);

  const items: ChecklistItem[] = [bankItem, journalItem, arItem, apItem, vatItem, tbItem];

  return {
    periodId,
    periodLabel: periodName,
    items,
    overallStatus: aggregateStatus(items),
  };
}
