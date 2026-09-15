/**
 * Migration Validation Service
 * PRD: Customer Migration Wizard — Phase 1
 *
 * Pre/post migration validation checks used in Step 8: Validation & Go-Live.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateSystemAccounts } from '../gl/systemAccountResolver';
import { checkAccountSubtypeCoverage } from './migrationSubtypeCheck';
import { PAYABLE_SUBTYPES, RECEIVABLE_SUBTYPES } from '../gl/accountSubtypes';
import { documentInPopulationExpr } from '../shared/documentPopulation';
import { documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import type { DbRow } from '@/types/db';

/**
 * This check reconciles the CURRENT invoice total against the CURRENT GL
 * balance — not a point-in-time reconstruction like the ageing reports. So
 * neither half is bounded by a real as-at date; the GL half was never date-
 * bounded (it sums every posted line, whenever dated), and the document half
 * must match that by asking `documentInLedgerAsAtFragment` for chain parity
 * over the WHOLE reversal chain, not "as at today".
 *
 * A REAL as-at date (round 3 review's first attempt: `asAtTodayStr()`) broke
 * on a document whose journal is dated in the future with no open fiscal
 * period for that date: `resolveReversalDate`'s default (no explicit date)
 * path falls back to TODAY when the target period isn't open, with no guard
 * against today being EARLIER than the future original — the one case
 * `documentInLedgerAsAtFragment`'s own precondition (no reversal dated before
 * its original) doesn't hold. Bounding the document half to today then
 * excluded the future original from the "on or before" filter while still
 * counting its reversal, flipping the parity to the wrong answer; bounding
 * the GL half to today the same way excluded the future original from the
 * SUM while still netting the reversal against nothing, for a different
 * wrong number. Measured on a fresh company each: a live future-dated
 * invoice regressed from pass to fail, and the soft-deleted one stayed wrong
 * (fail, different wrong numbers) either way.
 *
 * This sentinel sidesteps that precondition instead of tripping over it: at
 * a date far beyond any real journal entry, EVERY entry in the chain is
 * "on or before" it, so the filtered count is the chain's FULL length and its
 * parity no longer depends on which entry the chain happens to be checked
 * against — order stops mattering, which is exactly what a CURRENT-state
 * question (not a historical one) needs. Both future-dated shapes (live and
 * soft-deleted, fresh companies, AR and AP) pass with this — see fix.md.
 */
const CURRENT_STATE_SENTINEL = '9999-12-31';


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

  const [tb, arCheck, apCheck, sysAccounts, orphanAR, orphanAP, subtypes] = await Promise.all([
    checkTrialBalance(companyId),
    checkARvsGL(companyId),
    checkAPvsGL(companyId),
    checkSystemAccounts(companyId),
    checkOrphanARInvoices(companyId),
    checkOrphanAPInvoices(companyId),
    checkAccountSubtypeCoverage(companyId),
  ]);

  results.push(tb, arCheck, apCheck, sysAccounts, orphanAR, orphanAP, subtypes);

  log.info('Migration validation complete', {
    companyId,
    sessionId,
    passed: results.filter(r => r.status === 'pass').length,
    warned: results.filter(r => r.status === 'warn').length,
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
      AND jl.company_id = ${companyId}::UUID
      AND je.status = 'posted'
  `) as DbRow[];

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
    SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID
      AND ${sql.unsafe(documentInPopulationExpr('ci'))}
      -- A soft-deleted invoice's approval journal is reversed, so it must
      -- drop off the invoice side exactly once that reversal exists — the
      -- CURRENT_STATE_SENTINEL comment above explains why "exists" and not
      -- "as at today" (shared/softDeleteLedgerPresence).
      AND ${documentInLedgerAsAtFragment('ci', CURRENT_STATE_SENTINEL, companyId)}
  `) as DbRow[];

  // GL balance on receivable account — unbounded by date, same as the
  // document half above (see CURRENT_STATE_SENTINEL comment): this is a
  // CURRENT balance, not a point-in-time one.
  const glRows = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_subtype = ANY(${RECEIVABLE_SUBTYPES as string[]}::TEXT[])
      AND ga.company_id = ${companyId}::UUID
  `) as DbRow[];

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
    SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID
      AND ${sql.unsafe(documentInPopulationExpr('si'))}
      -- See checkARvsGL — same current-state parity rule, AP side.
      AND ${documentInLedgerAsAtFragment('si', CURRENT_STATE_SENTINEL, companyId)}
  `) as DbRow[];

  // See checkARvsGL — unbounded by date, AP side.
  const glRows = (await sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_subtype = ANY(${PAYABLE_SUBTYPES as string[]}::TEXT[])
      AND ga.company_id = ${companyId}::UUID
  `) as DbRow[];

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

async function checkSystemAccounts(companyId: string): Promise<ValidationResult> {
  const missing = await validateSystemAccounts(companyId);
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
  `) as DbRow[];

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
  `) as DbRow[];

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
