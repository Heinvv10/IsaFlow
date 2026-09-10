/**
 * The VAT integrity checks, and the test-data check.
 *
 * The first is the one that costs money. `list_bank_transactions` shows the VAT
 * code that was SUGGESTED, and a transaction can display "No VAT" while the
 * journal it posted claims input tax. Nobody reviewing the bank screen would
 * see the claim. There are 2,114 such transactions on Velocity Fibre and 1,103
 * on Brightsphere; the entertainment over-claim of roughly R50,000 was one of
 * them, found by hand.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { documentInLedgerAsAtFragment } from '../../shared/softDeleteLedgerPresence';
import { rewindAmount, effectivePaidExpr } from '../../shared/agingRewind';
import { num, r2, str, type IntegrityCheckContext, type IntegrityCheckResult, type IntegritySampleRow } from './types';

function sample(rows: DbRow[]): IntegritySampleRow[] {
  return rows.map((r) => ({
    id: str(r.id),
    label: str(r.label),
    amount: r.amount === null || r.amount === undefined ? undefined : r2(num(r.amount)),
    detail: r.detail === null || r.detail === undefined ? undefined : str(r.detail),
  }));
}

/**
 * Bank transactions whose displayed VAT code disagrees with the VAT their
 * journal actually posted.
 *
 * `amount` is the TAX at stake, not the transaction value — it is the number
 * that says whether to care.
 */
export async function vatDisplayedDiffersFromPosted(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const where = sql`
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    JOIN gl_journal_lines vl ON vl.journal_entry_id = jl.journal_entry_id AND vl.company_id = bt.company_id
    JOIN gl_accounts ga ON ga.id = vl.gl_account_id AND ga.company_id = bt.company_id
    WHERE bt.company_id = ${ctx.companyId}::UUID
      AND bt.transaction_date <= ${ctx.asAt}::DATE
      AND ga.account_subtype = ANY(ARRAY['vat_input', 'vat_output']::TEXT[])
      AND ABS(vl.debit - vl.credit) > 0.005
      AND COALESCE(bt.suggested_vat_code, 'no_vat') = 'no_vat'
  `;
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(ABS(vl.debit - vl.credit)), 0) AS amount ${where}
  `) as DbRow[];
  const rows = (await sql`
    SELECT bt.id::TEXT AS id,
           COALESCE(NULLIF(bt.reference, ''), bt.bank_reference, LEFT(COALESCE(bt.description, ''), 60)) AS label,
           ABS(vl.debit - vl.credit) AS amount,
           'displayed "' || COALESCE(bt.suggested_vat_code, 'No VAT')
             || '" but posted ' || ga.account_code || ' ' || ga.account_name AS detail
    ${where}
    ORDER BY ABS(vl.debit - vl.credit) DESC
    LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'vat_displayed_differs_from_posted',
    label: 'Bank transactions showing no VAT whose journal claims VAT',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'The bank screen shows no VAT and the journal claims it. Nobody reviewing the transaction sees the claim, so it reaches the VAT201 unreviewed. The amount is the TAX at stake, not the value of the transactions.',
  };
}

/**
 * Test and demo records in a production book.
 *
 * "QA Test Customer" holds R10,000 against Brightsphere's debtors and is
 * indistinguishable from a real customer in every report. The pattern is
 * conservative: it matches names that announce themselves.
 */
const TEST_NAME_PATTERN = '(^|[^a-z])(test|demo|dummy|sample|qa|stresstest|e2e|delete[ -]?me)([^a-z]|$)';

export async function testRecordsInProduction(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  // "Its balance is in the aging": so it is the ageing's balance AT ctx.asAt —
  // the shared rewind and population (R-059). This summed TODAY's amount_paid
  // over every document, drafts, cancelled and deleted ones included.
  const todayStr = fmtDate(new Date());
  const candidates = sql`
    SELECT cu.id::TEXT AS id, 'customer' AS kind, cu.name,
           COALESCE((
             SELECT SUM(ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))})
             FROM customer_invoices ci
             LEFT JOIN LATERAL (
               ${rewindAmount({ companyId: ctx.companyId, asAtStr: ctx.asAt, todayStr, side: 'ar' })}
             ) unpaid ON TRUE
             WHERE ci.company_id = cu.company_id
               AND COALESCE(ci.client_id, ci.customer_id) = cu.id
               AND ${documentInLedgerAsAtFragment('ci', ctx.asAt, ctx.companyId)}
               AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${ctx.asAt}::DATE
               -- COALESCE: status is NULLABLE, so the bare form dropped
               -- null-status documents the ageing itself keeps (K-091).
               AND COALESCE(ci.status, '') NOT IN ('draft', 'cancelled')
               AND (ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))}) > 0
           ), 0) AS amount
    FROM customers cu
    WHERE cu.company_id = ${ctx.companyId}::UUID AND cu.name ~* ${TEST_NAME_PATTERN}
    UNION ALL
    SELECT s.id::TEXT, 'supplier', s.name,
           COALESCE((
             SELECT SUM(si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))})
             FROM supplier_invoices si
             LEFT JOIN LATERAL (
               ${rewindAmount({ companyId: ctx.companyId, asAtStr: ctx.asAt, todayStr, side: 'ap' })}
             ) unpaid ON TRUE
             WHERE si.company_id = s.company_id AND si.supplier_id = s.id
               AND ${documentInLedgerAsAtFragment('si', ctx.asAt, ctx.companyId)}
               AND si.invoice_date <= ${ctx.asAt}::DATE
               -- COALESCE: status is NULLABLE, so the bare form dropped
               -- null-status documents the ageing itself keeps (K-091).
               AND COALESCE(si.status, '') NOT IN ('draft', 'cancelled')
               AND (si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))}) > 0
           ), 0)
    FROM suppliers s
    WHERE s.company_id = ${ctx.companyId}::UUID AND s.name ~* ${TEST_NAME_PATTERN}
  `;
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(ABS(c.amount)), 0) AS amount FROM (${candidates}) c
  `) as DbRow[];
  const rows = (await sql`
    SELECT c.id, c.name AS label, c.amount, c.kind || ' record with a test-looking name' AS detail
    FROM (${candidates}) c ORDER BY ABS(c.amount) DESC, c.name LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'test_records_in_production',
    label: 'Test and demo records in a production book',
    severity: 'medium',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'A record whose name announces it as a test, carrying a real balance. It is indistinguishable from a live customer or supplier in every report, and its balance is in the aging and the control account. The amount is the outstanding balance behind these records.',
  };
}
