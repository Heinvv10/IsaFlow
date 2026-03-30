/**
 * Migration Validation Service
 * PRD: Customer Migration Wizard — Phase 1
 *
 * Pre/post migration validation checks used in Step 8: Validation & Go-Live.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateSystemAccounts } from './systemAccountResolver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export type ValidationStatus = 'pass' | 'fail' | 'warn';

export interface ValidationResult {
  check: string;
  status: ValidationStatus;
  message: string;
  detail?: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all post-migration validation checks.
 * Returns a list of results — caller decides pass/fail threshold.
 */
export async function validateMigration(
  companyId: string,
  sessionId: string,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  const [tb, arCheck, apCheck, sysAccounts, orphanAR, orphanAP] = await Promise.all([
    checkTrialBalance(companyId),
    checkARvsGL(companyId),
    checkAPvsGL(companyId),
    checkSystemAccounts(),
    checkOrphanARInvoices(companyId),
    checkOrphanAPInvoices(companyId),
  ]);

  results.push(tb, arCheck, apCheck, sysAccounts, orphanAR, orphanAP);

  log.info('Migration validation complete', {
    companyId,
    sessionId,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
  }, 'migration');

  return results;
}

// ── Checks ───────────────────────────────────────────────────────────────────

async function checkTrialBalance(companyId: string): Promise<ValidationResult> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(jl.debit), 0)  AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
  `) as Row[];

  const totalDebit  = Number(rows[0]?.total_debit ?? 0);
  const totalCredit = Number(rows[0]?.total_credit ?? 0);
  const diff = Math.abs(totalDebit - totalCredit);

  if (diff <= 0.01) {
    return { check: 'Trial Balance', status: 'pass', message: 'Debits equal credits', detail: `Total: R${totalDebit.toFixed(2)}` };
  }

  return {
    check: 'Trial Balance',
    status: 'fail',
    message: 'Trial balance is not balanced',
    detail: `Debits: R${totalDebit.toFixed(2)}, Credits: R${totalCredit.toFixed(2)}, Diff: R${diff.toFixed(2)}`,
  };
}

async function checkARvsGL(companyId: string): Promise<ValidationResult> {
  // Sum of open customer invoice balances
  const invRows = (await sql`
    SELECT COALESCE(SUM(balance_due), 0) AS total
    FROM customer_invoices
    WHERE company_id = ${companyId}::UUID
      AND status IN ('approved', 'partially_paid', 'overdue')
  `) as Row[];

  // GL balance on receivable account
  const glRows = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_subtype = 'receivable'
      AND ga.company_id = ${companyId}::UUID
  `) as Row[];

  const invoiceTotal = Number(invRows[0]?.total ?? 0);
  const glBalance    = Number(glRows[0]?.balance ?? 0);
  const diff = Math.abs(invoiceTotal - glBalance);

  if (diff <= 0.01) {
    return { check: 'AR vs GL', status: 'pass', message: 'AR invoices match GL receivable balance', detail: `R${invoiceTotal.toFixed(2)}` };
  }

  return {
    check: 'AR vs GL',
    status: diff > 100 ? 'fail' : 'warn',
    message: 'AR invoice total does not exactly match GL receivable',
    detail: `Invoices: R${invoiceTotal.toFixed(2)}, GL: R${glBalance.toFixed(2)}, Diff: R${diff.toFixed(2)}`,
  };
}

async function checkAPvsGL(companyId: string): Promise<ValidationResult> {
  const invRows = (await sql`
    SELECT COALESCE(SUM(balance_due), 0) AS total
    FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID
      AND status IN ('approved', 'partially_paid', 'overdue')
  `) as Row[];

  const glRows = (await sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_subtype = 'payable'
      AND ga.company_id = ${companyId}::UUID
  `) as Row[];

  const invoiceTotal = Number(invRows[0]?.total ?? 0);
  const glBalance    = Number(glRows[0]?.balance ?? 0);
  const diff = Math.abs(invoiceTotal - glBalance);

  if (diff <= 0.01) {
    return { check: 'AP vs GL', status: 'pass', message: 'AP invoices match GL payable balance', detail: `R${invoiceTotal.toFixed(2)}` };
  }

  return {
    check: 'AP vs GL',
    status: diff > 100 ? 'fail' : 'warn',
    message: 'AP invoice total does not exactly match GL payable',
    detail: `Invoices: R${invoiceTotal.toFixed(2)}, GL: R${glBalance.toFixed(2)}, Diff: R${diff.toFixed(2)}`,
  };
}

async function checkSystemAccounts(): Promise<ValidationResult> {
  const missing = await validateSystemAccounts();
  if (missing.length === 0) {
    return { check: 'System Accounts', status: 'pass', message: 'All system accounts are mapped and active' };
  }
  return {
    check: 'System Accounts',
    status: 'fail',
    message: `${missing.length} system account(s) not mapped`,
    detail: `Missing: ${missing.join(', ')}`,
  };
}

async function checkOrphanARInvoices(companyId: string): Promise<ValidationResult> {
  const rows = (await sql`
    SELECT COUNT(*) AS cnt
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID
      AND COALESCE(ci.client_id, ci.customer_id) IS NULL
  `) as Row[];

  const cnt = Number(rows[0]?.cnt ?? 0);
  if (cnt === 0) {
    return { check: 'Orphan AR Invoices', status: 'pass', message: 'All customer invoices have a linked customer' };
  }
  return {
    check: 'Orphan AR Invoices',
    status: 'fail',
    message: `${cnt} customer invoice(s) have no linked customer`,
    detail: 'These invoices will not appear in AR aging reports',
  };
}

async function checkOrphanAPInvoices(companyId: string): Promise<ValidationResult> {
  const rows = (await sql`
    SELECT COUNT(*) AS cnt
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID
      AND si.supplier_id IS NULL
  `) as Row[];

  const cnt = Number(rows[0]?.cnt ?? 0);
  if (cnt === 0) {
    return { check: 'Orphan AP Invoices', status: 'pass', message: 'All supplier invoices have a linked supplier' };
  }
  return {
    check: 'Orphan AP Invoices',
    status: 'fail',
    message: `${cnt} supplier invoice(s) have no linked supplier`,
    detail: 'These invoices will not appear in AP aging reports',
  };
}
