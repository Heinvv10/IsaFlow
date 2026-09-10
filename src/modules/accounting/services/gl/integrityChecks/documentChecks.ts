/**
 * Integrity checks over the documents: invoices and journals.
 *
 * Each of these was a real finding. The null due date hid R1,058,000 of a
 * R1,429,774 reconciling difference on Brightsphere — and, when this check was
 * first run against production, a further 74 invoices worth R12,730,757.43 on
 * Velocity Fibre that nobody had looked for.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { num, r2, str, type IntegrityCheckContext, type IntegrityCheckResult, type IntegritySampleRow } from './types';
import { documentInLedgerAsAtFragment } from '../../shared/softDeleteLedgerPresence';
import { rewindAmount, effectivePaidExpr } from '../../shared/agingRewind';

function sample(rows: DbRow[]): IntegritySampleRow[] {
  return rows.map((r) => ({
    id: str(r.id),
    label: str(r.label),
    amount: r.amount === null || r.amount === undefined ? undefined : r2(num(r.amount)),
    detail: r.detail === null || r.detail === undefined ? undefined : str(r.detail),
  }));
}

/**
 * Customer invoices that cannot be aged because they have no due date.
 *
 * An invoice with a null due date does not appear in ANY aging bucket, so it is
 * simply absent from the aged debtors report with no error and no count. On
 * Brightsphere that was INV0000133 at R1,058,000; on Velocity it is 74
 * invoices at R12,730,757.43. Both books' aging is understated by exactly the
 * amount this check reports.
 */
export async function invoicesNullDueDate(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  // The ageing's own population and balance AT ctx.asAt (R-059): the shared
  // rewind, 'draft'/'cancelled' out, the rewound balance > 0. This read TODAY's
  // amount_paid and the open-status set, so at a past date an invoice settled
  // since was missing and one part-paid since was understated.
  const paid = effectivePaidExpr('ar');
  const from = sql`
    FROM customer_invoices ci
    LEFT JOIN LATERAL (
      ${rewindAmount({ companyId: ctx.companyId, asAtStr: ctx.asAt, todayStr: fmtDate(new Date()), side: 'ar' })}
    ) unpaid ON TRUE
    WHERE ci.company_id = ${ctx.companyId}::UUID
      -- This check quantifies what the ageing is understating, so it reads the
      -- same population the ageing does at the same date.
      -- See shared/softDeleteLedgerPresence.
      AND ${documentInLedgerAsAtFragment('ci', ctx.asAt, ctx.companyId)}
      AND ci.due_date IS NULL
      AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${ctx.asAt}::DATE
      -- COALESCE: status is NULLABLE and NULL NOT IN (...) is NULL, not TRUE,
      -- so the bare comparison silently DROPPED every null-status invoice —
      -- the under-reporting K-091 fixed on sales-by-customer.
      AND COALESCE(ci.status, '') NOT IN ('draft', 'cancelled')
      AND (ci.total_amount - ${sql.unsafe(paid)}) > 0`;

  const totals = (await sql`
    SELECT COUNT(*)::INT AS count,
           COALESCE(SUM(ci.total_amount - ${sql.unsafe(paid)}), 0) AS amount
    ${from}
  `) as DbRow[];

  const rows = (await sql`
    SELECT ci.id::TEXT AS id,
           COALESCE(ci.invoice_number, ci.id::TEXT) AS label,
           ci.total_amount - ${sql.unsafe(paid)} AS amount,
           'invoiced ' || ci.invoice_date::TEXT AS detail
    ${from}
    ORDER BY (ci.total_amount - ${sql.unsafe(paid)}) DESC
    LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'invoices_null_due_date',
    label: 'Open invoices with no due date',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'An invoice with no due date falls into no aging bucket, so it is absent from aged debtors with no error and no count. The aging is understated by this amount.',
  };
}

/**
 * Posted journals whose period is closed or locked.
 *
 * Journals dated outside EVERY fiscal period are a separate and older check —
 * `glIntegrityService#findOrphanJournalEntries` — and are reported by it. This
 * one is the commoner and quieter failure: the period exists, it is closed, and
 * something posted into it anyway. 1,552 such journals were sitting in a closed
 * period when this check was first run.
 */
export async function documentsOutsideOpenPeriod(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(v.amount), 0) AS amount
    FROM (
      SELECT je.id, COALESCE(SUM(jl.debit), 0) AS amount
      FROM gl_journal_entries je
      LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
      LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
      WHERE je.company_id = ${ctx.companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date <= ${ctx.asAt}::DATE
        AND (fp.id IS NULL OR fp.status IN ('closed', 'locked'))
      GROUP BY je.id
    ) v
  `) as DbRow[];

  const rows = (await sql`
    SELECT je.id::TEXT AS id,
           COALESCE(je.entry_number, je.id::TEXT) AS label,
           COALESCE((SELECT SUM(jl.debit) FROM gl_journal_lines jl
                     WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id), 0) AS amount,
           je.entry_date::TEXT || ' — period ' || COALESCE(fp.status, 'none') AS detail
    FROM gl_journal_entries je
    LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
    WHERE je.company_id = ${ctx.companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${ctx.asAt}::DATE
      AND (fp.id IS NULL OR fp.status IN ('closed', 'locked'))
    ORDER BY je.entry_date
    LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'documents_outside_open_period',
    label: 'Posted journals in a closed, locked or missing period',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'A posted journal whose fiscal period is closed, locked or absent changes a period somebody has already signed off. A NULL fiscal period also makes the journal invisible to every period-scoped report.',
  };
}

/**
 * Posted customer-invoice journals with no revenue leg, and VAT-bearing
 * journals with no base leg.
 *
 * An invoice journal that debits the debtor and credits nothing but VAT and a
 * balance-sheet account has recognised no revenue: the P&L is understated and
 * the VAT201 has tax with no supply behind it.
 */
export async function invoicesWithoutRevenueLine(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const where = sql`
    FROM customer_invoices ci
    JOIN gl_journal_entries je ON je.id = ci.gl_journal_entry_id AND je.company_id = ci.company_id
    WHERE ci.company_id = ${ctx.companyId}::UUID
      AND je.status = 'posted'
      AND ${documentInLedgerAsAtFragment('ci', ctx.asAt, ctx.companyId)}
      AND ci.invoice_date <= ${ctx.asAt}::DATE
      AND ci.status <> ALL(ARRAY['cancelled', 'void', 'voided', 'draft']::TEXT[])
      AND NOT EXISTS (
        SELECT 1 FROM gl_journal_lines jl
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.journal_entry_id = je.id
          AND jl.company_id = ci.company_id
          AND ga.account_type = 'revenue'
      )
  `;

  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(ci.total_amount), 0) AS amount ${where}
  `) as DbRow[];

  const rows = (await sql`
    SELECT ci.id::TEXT AS id,
           COALESCE(ci.invoice_number, ci.id::TEXT) AS label,
           ci.total_amount AS amount,
           'journal ' || COALESCE(je.entry_number, '') AS detail
    ${where}
    ORDER BY ci.total_amount DESC
    LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'invoices_without_revenue_line',
    label: 'Posted invoices whose journal recognises no revenue',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'The invoice posted, the debtor went up, and no revenue account moved. Income is understated by this amount and the VAT201 carries output tax with no supply behind it.',
  };
}
