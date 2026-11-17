/**
 * Post-checks over the Demo ledger (PLAN 7.2: J1-J3, A1-A3, B1-B2, C1). Read-only.
 */

import type { CheckResult } from '../integrityTypes';
import type { Window } from './dates';
import type { Tx } from './db';

const pass = (label: string, detail: string): CheckResult => ({ label, status: 'pass', detail });
const fail = (label: string, lines: string[]): CheckResult => ({ label, status: 'fail', offending: lines.length, detail: `${lines.length} problem(s)`, lines: lines.slice(0, 25) });
const judge = (label: string, lines: string[], ok: string): CheckResult => (lines.length === 0 ? pass(label, ok) : fail(label, lines));

export async function checkJ(tx: Tx, companyId: string): Promise<CheckResult[]> {
  const unbalanced = await tx.query<{ entry_number: string; off: string }>(`
    SELECT je.entry_number, (coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0))::text AS off
    FROM gl_journal_entries je LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.company_id = $1::uuid AND je.status = 'posted'
    GROUP BY je.id, je.entry_number HAVING count(jl.id) = 0 OR sum(jl.debit) <> sum(jl.credit)`, [companyId]);
  const [tb] = await tx.query<{ off: string }>(`
    SELECT (coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0))::text AS off
    FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = $1::uuid AND je.status = 'posted'`, [companyId]);
  const periods = await tx.query<{ entry_number: string }>(`
    SELECT je.entry_number FROM gl_journal_entries je LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
    WHERE je.company_id = $1::uuid AND je.status = 'posted'
      AND (fp.id IS NULL OR je.entry_date NOT BETWEEN fp.start_date AND fp.end_date)`, [companyId]);
  const dups = await tx.query<{ entry_number: string }>(`
    SELECT entry_number FROM gl_journal_entries WHERE company_id = $1::uuid GROUP BY entry_number HAVING count(*) > 1`, [companyId]);
  return [
    judge('J1 Journal balance per entry', unbalanced.map((r) => `${r.entry_number} off ${r.off}`), 'every posted Demo journal balances'),
    Number(tb?.off ?? 0) === 0 ? pass('J2 Trial balance', 'debits equal credits') : fail('J2 Trial balance', [`out by ${tb?.off}`]),
    judge('J3 Periods and numbers', [...periods.map((r) => `${r.entry_number}: no covering fiscal period`), ...dups.map((r) => `${r.entry_number}: duplicate`)],
      'every posted journal sits in its period; numbers unique'),
  ];
}

export async function checkA(tx: Tx, companyId: string, win: Window): Promise<CheckResult[]> {
  const [ar] = await tx.query<{ open: number; b1: number; b2: number; b3: number; oldest: number | null }>(`
    SELECT count(*)::int AS open,
      count(*) FILTER (WHERE $2::date - due_date BETWEEN 1 AND 30)::int AS b1,
      count(*) FILTER (WHERE $2::date - due_date BETWEEN 31 AND 60)::int AS b2,
      count(*) FILTER (WHERE $2::date - due_date BETWEEN 61 AND 90)::int AS b3,
      max($2::date - due_date) FILTER (WHERE due_date < $2::date)::int AS oldest
    FROM customer_invoices WHERE company_id = $1::uuid AND deleted_at IS NULL
      AND status IN ('sent', 'approved', 'partially_paid', 'overdue') AND total_amount - coalesce(amount_paid, 0) > 0`, [companyId, win.today]);
  const a1: string[] = [];
  if (!ar || ar.open < 10 || ar.open > 20) a1.push(`open invoices ${ar?.open ?? 0}, want 10..20`);
  if ((ar?.oldest ?? 0) > 180) a1.push(`oldest overdue ${ar?.oldest} days, want <= 180`);
  if (ar && (ar.b1 === 0 || ar.b2 === 0 || ar.b3 === 0)) a1.push(`overdue bands 1-30/31-60/61-90: ${ar.b1}/${ar.b2}/${ar.b3}, want each > 0`);
  const [ap] = await tx.query<{ open: number; oldest: number | null }>(`
    SELECT count(*)::int AS open, max($2::date - due_date) FILTER (WHERE due_date < $2::date)::int AS oldest
    FROM supplier_invoices WHERE company_id = $1::uuid AND deleted_at IS NULL
      AND status IN ('approved', 'partially_paid') AND total_amount - coalesce(amount_paid, 0) > 0`, [companyId, win.today]);
  const ties = await tx.query<{ what: string; diff: string }>(`
    SELECT 'invoice ' || ci.invoice_number AS what, (ci.amount_paid - coalesce(sum(a.amount_allocated), 0))::text AS diff
      FROM customer_invoices ci LEFT JOIN customer_payment_allocations a ON a.invoice_id = ci.id
     WHERE ci.company_id = $1::uuid GROUP BY ci.id HAVING ci.amount_paid <> coalesce(sum(a.amount_allocated), 0)
    UNION ALL
    SELECT 'bill ' || si.invoice_number, (si.amount_paid - coalesce(sum(a.amount_allocated), 0))::text
      FROM supplier_invoices si LEFT JOIN payment_allocations a ON a.invoice_id = si.id
     WHERE si.company_id = $1::uuid GROUP BY si.id HAVING si.amount_paid <> coalesce(sum(a.amount_allocated), 0)
    UNION ALL
    SELECT 'AR control vs open invoices', (gl.bal - docs.bal)::text FROM
      (SELECT coalesce(sum(jl.debit - jl.credit), 0) AS bal FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts a ON a.id = jl.gl_account_id
        WHERE je.company_id = $1::uuid AND je.status = 'posted' AND a.is_system_account AND a.account_subtype = 'receivable') gl,
      (SELECT coalesce(sum(total_amount - amount_paid), 0) AS bal FROM customer_invoices WHERE company_id = $1::uuid AND status <> 'draft' AND deleted_at IS NULL) docs
     WHERE gl.bal <> docs.bal
    UNION ALL
    SELECT 'AP control vs open bills', (gl.bal - docs.bal)::text FROM
      (SELECT coalesce(sum(jl.credit - jl.debit), 0) AS bal FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts a ON a.id = jl.gl_account_id
        WHERE je.company_id = $1::uuid AND je.status = 'posted' AND a.is_system_account AND a.account_subtype = 'payable') gl,
      (SELECT coalesce(sum(total_amount - amount_paid), 0) AS bal FROM supplier_invoices WHERE company_id = $1::uuid AND status <> 'draft' AND deleted_at IS NULL) docs
     WHERE gl.bal <> docs.bal`, [companyId]);
  return [
    judge('A1 Customer ageing', a1, `${ar?.open} open; overdue bands ${ar?.b1}/${ar?.b2}/${ar?.b3}; oldest ${ar?.oldest ?? 0} days`),
    (ap?.oldest ?? 0) > 180 ? fail('A2 Supplier ageing', [`oldest overdue bill ${ap?.oldest} days`]) : pass('A2 Supplier ageing', `${ap?.open} open; oldest overdue ${ap?.oldest ?? 0} days`),
    judge('A3 Subledger ties', ties.map((r) => `${r.what}: off ${r.diff}`), 'allocations, AR and AP control accounts tie to the documents'),
  ];
}

export async function checkB(tx: Tx, companyId: string, win: Window): Promise<CheckResult[]> {
  const [b] = await tx.query<Record<string, string | number | null>>(`
    WITH bank AS (SELECT DISTINCT bank_account_id AS id FROM bank_transactions WHERE company_id = $1::uuid),
    gl AS (SELECT
        coalesce(sum(jl.debit - jl.credit) FILTER (WHERE je.entry_date <= $2::date), 0) AS at_lme,
        coalesce(sum(jl.debit - jl.credit), 0) AS at_today
      FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = $1::uuid AND je.status = 'posted' AND jl.gl_account_id IN (SELECT id FROM bank))
    SELECT gl.at_lme::text AS gl_lme, gl.at_today::text AS gl_today,
      (SELECT coalesce(sum(amount), 0) FROM bank_transactions WHERE company_id = $1::uuid AND status = 'reconciled')::text AS reconciled,
      (SELECT coalesce(sum(amount), 0) FROM bank_transactions WHERE company_id = $1::uuid)::text AS all_lines,
      (SELECT statement_balance::text FROM bank_reconciliations WHERE company_id = $1::uuid AND status = 'completed'
        ORDER BY statement_date DESC LIMIT 1) AS last_recon,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1::uuid AND status = 'reconciled' AND matched_journal_line_id IS NULL)::int AS recon_unlinked,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1::uuid AND transaction_date <= $2::date AND status <> 'reconciled')::int AS old_unreconciled,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1::uuid AND transaction_date > $2::date AND status = 'matched')::int AS cur_matched,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1::uuid AND transaction_date > $2::date AND status = 'imported')::int AS cur_open
    FROM gl`, [companyId, win.lastMonthEnd]);
  const b1: string[] = [];
  if (b && (Number(b.gl_lme) !== Number(b.reconciled) || Number(b.reconciled) !== Number(b.last_recon ?? 0))) {
    b1.push(`at ${win.lastMonthEnd}: GL ${b.gl_lme}, reconciled lines ${b.reconciled}, last reconciliation ${b.last_recon}`);
  }
  if (b && Number(b.gl_today) !== Number(b.all_lines)) b1.push(`today: GL ${b.gl_today}, all bank lines ${b.all_lines}`);
  const b2: string[] = [];
  if (Number(b?.recon_unlinked ?? 0) > 0) b2.push(`${b?.recon_unlinked} reconciled line(s) without a journal link`);
  if (Number(b?.old_unreconciled ?? 0) > 0) b2.push(`${b?.old_unreconciled} line(s) up to last month end not reconciled`);
  if (Number(b?.cur_matched ?? 0) === 0 || Number(b?.cur_open ?? 0) === 0) b2.push(`current month matched/unmatched: ${b?.cur_matched}/${b?.cur_open}, want both > 0`);
  return [
    judge('B1 Bank ties to GL', b1, `GL at last month end ${b?.gl_lme} = reconciled lines = last reconciliation; today ${b?.gl_today}`),
    judge('B2 Bank line states', b2, `reconciled to ${win.lastMonthEnd}; current month ${b?.cur_matched} matched, ${b?.cur_open} to do`),
  ];
}

export async function checkC1(tx: Tx, companyId: string): Promise<CheckResult> {
  const [r] = await tx.query<{ bad: number }>(`
    WITH truth AS (
      SELECT jl.gl_account_id, je.fiscal_period_id, sum(jl.debit) AS d, sum(jl.credit) AS c
      FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = $1::uuid AND je.status = 'posted' AND je.fiscal_period_id IS NOT NULL GROUP BY 1, 2),
    cache AS (SELECT * FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1::uuid))
    SELECT count(*)::int AS bad FROM truth t FULL JOIN cache c ON c.gl_account_id = t.gl_account_id AND c.fiscal_period_id = t.fiscal_period_id
    WHERE t.gl_account_id IS NULL AND (c.debit_total <> 0 OR c.credit_total <> 0)
       OR c.gl_account_id IS NULL
       OR c.debit_total <> t.d OR c.credit_total <> t.c OR c.balance <> t.d - t.c`, [companyId]);
  return (r?.bad ?? 0) === 0
    ? pass('C1 Balance cache', 'no missing, stale or mismatched Demo cache rows')
    : fail('C1 Balance cache', [`${r?.bad} missing, stale or mismatched cache row(s)`]);
}
