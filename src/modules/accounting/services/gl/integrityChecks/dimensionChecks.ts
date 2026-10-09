/**
 * Integrity checks over the CC1 / CC2 analysis dimensions.
 *
 * A line that carries a project (CC2) stores the FNO (CC1) that was derived
 * from the project's parent chain when the line was written. Moving a project
 * to another FNO is refused while anything carries it (dimensionMasterEdit,
 * countCc2Carriers), but journal posting does not take the master lock, so a
 * line committed while the move was being planned can keep the old FNO. That
 * race is answered by detection, not by locking (Hein, 2026-10-09).
 *
 * COVERED: posted journal lines; un-allocated bank lines; customer invoice
 * lines, supplier invoice lines and credit notes in the document population.
 * NOT COVERED, on purpose: gl_accounts.default_cc1 / default_cc2 (independent
 * card defaults, never a derived pair) and un-reversed tag-batch old_cc2_id
 * (history a reversal restores, not a carrier of a current figure) — both still
 * block the move itself through countCc2Carriers.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';
import { num, r2, str, type IntegrityCheckContext, type IntegrityCheckResult } from './types';

/** The same bound as dimensionDerivation.deriveFnoId. */
const MAX_DEPTH = 16;

/**
 * Lines whose stored CC1 contradicts the FNO their CC2 derives TODAY.
 *
 * The derivation mirrors deriveFnoId: walk the CC2's parents, company-scoped,
 * to the first CC1; a cycle, a missing parent or no CC1 derives none. A CC2
 * that derives NO FNO is never flagged: a CC1 beside it is what
 * applyFnoDerivation / applyCustomerFno write on purpose (the customer's FNO).
 *
 * Per carrier:
 *   - journal lines: posted (or reversed), dated <= as_at, and in force AS AT
 *     as_at — a reversal pair dated by then is skipped whole (the chain-parity
 *     test bankMatchDbQueries uses), so one move is not counted twice; an entry
 *     reversed only after as_at was in force on as_at and is kept. A stored NULL CC1 under a project that now
 *     derives one IS flagged: every new journal line derives its CC1.
 *   - bank lines: un-allocated only (an allocated row's journal line is checked
 *     above), feed_state not 'removed', and a CC1 actually stored — a CC2-only
 *     selection stores NULL by design (planAllocationDimensions).
 *   - documents: issued (shared/documentPopulation; credit notes: not draft or
 *     cancelled), not deleted, dated <= as_at, with a CC1 stored — a CC2-only
 *     line saved before 873 is refused at approval, not here.
 */
export async function projectFnoMismatch(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const failing = sql`
    WITH RECURSIVE walk(start_id, node_id, depth, path) AS (
      SELECT cc.id, cc.parent_id, 1, ARRAY[cc.id]
      FROM cost_centres cc
      WHERE cc.company_id = ${ctx.companyId}::UUID AND cc.parent_id IS NOT NULL
      UNION ALL
      SELECT w.start_id, p.parent_id, w.depth + 1, w.path || p.id
      FROM walk w
      JOIN cost_centres p ON p.id = w.node_id AND p.company_id = ${ctx.companyId}::UUID
      WHERE p.cc_type IS DISTINCT FROM 'cc1' AND p.parent_id IS NOT NULL
        AND NOT (p.id = ANY(w.path)) AND w.depth < ${MAX_DEPTH}
    ),
    derived AS (
      SELECT DISTINCT ON (w.start_id) w.start_id AS cc2_id, p.id AS fno_id
      FROM walk w
      JOIN cost_centres p ON p.id = w.node_id AND p.company_id = ${ctx.companyId}::UUID
      WHERE p.cc_type = 'cc1' AND NOT (p.id = ANY(w.path))
      ORDER BY w.start_id, w.depth
    ),
    failing AS (
      SELECT jl.id::TEXT AS id, COALESCE(je.entry_number, je.id::TEXT) AS label,
             GREATEST(COALESCE(jl.debit, 0), COALESCE(jl.credit, 0)) AS amount,
             'journal line' AS kind, jl.cc1_id, jl.cc2_id, d.fno_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      LEFT JOIN gl_journal_entries orig ON orig.id = je.reversal_of_id AND orig.company_id = je.company_id
      LEFT JOIN gl_journal_entries orig2 ON orig2.id = orig.reversal_of_id AND orig2.company_id = je.company_id
      JOIN derived d ON d.cc2_id = jl.cc2_id
      WHERE jl.company_id = ${ctx.companyId}::UUID AND je.status IN ('posted', 'reversed')
        AND je.entry_date <= ${ctx.asAt}::DATE
        -- Undone AS AT as_at: a reversal dated on or before it (by its entry_date), or — a reversed entry with
        -- no reversal row — reversed_at on or before it. Reversed later, the line was still in force then.
        AND NOT EXISTS (
          SELECT 1 FROM gl_journal_entries r
          WHERE r.reversal_of_id = je.id AND r.company_id = je.company_id
            AND r.status IN ('posted', 'reversed') AND r.entry_date <= ${ctx.asAt}::DATE)
        AND NOT (je.reversed_at IS NOT NULL AND je.reversed_at::DATE <= ${ctx.asAt}::DATE AND NOT EXISTS (
          SELECT 1 FROM gl_journal_entries r WHERE r.reversal_of_id = je.id AND r.company_id = je.company_id))
        -- A reversal (an odd step down the chain) nets its original; a reversal of a reversal is in force.
        AND NOT (je.reversal_of_id IS NOT NULL AND (orig.reversal_of_id IS NULL OR orig2.reversal_of_id IS NOT NULL))
        AND jl.cc1_id IS DISTINCT FROM d.fno_id
      UNION ALL
      SELECT bt.id::TEXT, COALESCE(bt.reference, bt.description, bt.id::TEXT),
             ABS(bt.amount), 'bank line', bt.cc1_id, bt.cc2_id, d.fno_id
      FROM bank_transactions bt
      JOIN derived d ON d.cc2_id = bt.cc2_id
      WHERE bt.company_id = ${ctx.companyId}::UUID AND bt.feed_state <> 'removed'
        AND bt.matched_journal_line_id IS NULL
        AND bt.transaction_date <= ${ctx.asAt}::DATE
        AND bt.cc1_id IS NOT NULL AND bt.cc1_id <> d.fno_id
      UNION ALL
      SELECT sii.id::TEXT, COALESCE(si.invoice_number, si.id::TEXT),
             ABS(COALESCE(sii.line_total, 0)), 'supplier invoice line', sii.cc1_id, sii.cc2_id, d.fno_id
      FROM supplier_invoice_items sii
      JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
      JOIN derived d ON d.cc2_id = sii.cc2_id
      WHERE si.company_id = ${ctx.companyId}::UUID AND ${sql.unsafe(documentInPopulationExpr('si'))}
        AND si.deleted_at IS NULL AND si.invoice_date <= ${ctx.asAt}::DATE
        AND sii.cc1_id IS NOT NULL AND sii.cc1_id <> d.fno_id
      UNION ALL
      SELECT cii.id::TEXT, COALESCE(ci.invoice_number, ci.id::TEXT),
             ABS(COALESCE(cii.amount, 0)), 'customer invoice line', cii.cc1_id, cii.cc2_id, d.fno_id
      FROM customer_invoice_items cii
      JOIN customer_invoices ci ON ci.id = cii.invoice_id
      JOIN derived d ON d.cc2_id = cii.cc2_id
      WHERE ci.company_id = ${ctx.companyId}::UUID AND ${sql.unsafe(documentInPopulationExpr('ci'))}
        AND ci.deleted_at IS NULL AND COALESCE(ci.invoice_date, ci.created_at::DATE) <= ${ctx.asAt}::DATE
        AND cii.cc1_id IS NOT NULL AND cii.cc1_id <> d.fno_id
      UNION ALL
      SELECT cn.id::TEXT, COALESCE(cn.credit_note_number, cn.id::TEXT),
             ABS(COALESCE(cn.total_amount, 0)), 'credit note', cn.cc1_id, cn.cc2_id, d.fno_id
      FROM credit_notes cn
      JOIN derived d ON d.cc2_id = cn.cc2_id
      WHERE cn.company_id = ${ctx.companyId}::UUID AND COALESCE(cn.status, 'draft') NOT IN ('draft', 'cancelled')
        AND cn.credit_date <= ${ctx.asAt}::DATE
        AND cn.cc1_id IS NOT NULL AND cn.cc1_id <> d.fno_id
    )`;

  const totals = (await sql`
    ${failing}
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(amount), 0) AS amount FROM failing
  `) as DbRow[];

  const rows = (await sql`
    ${failing}
    SELECT f.id, f.label, f.amount,
           f.kind || ': project ' || COALESCE(p.code, '?') || ' stores FNO ' || COALESCE(s.code, '(none)')
             || ', derives ' || COALESCE(n.code, '(none)') AS detail
    FROM failing f
    LEFT JOIN cost_centres p ON p.id = f.cc2_id AND p.company_id = ${ctx.companyId}::UUID
    LEFT JOIN cost_centres s ON s.id = f.cc1_id AND s.company_id = ${ctx.companyId}::UUID
    LEFT JOIN cost_centres n ON n.id = f.fno_id AND n.company_id = ${ctx.companyId}::UUID
    ORDER BY f.amount DESC, f.id
    LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'project_fno_mismatch',
    label: 'Lines whose FNO (CC1) is not the one their project (CC2) derives',
    severity: 'medium',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: rows.map((r) => ({ id: str(r.id), label: str(r.label), amount: r2(num(r.amount)), detail: str(r.detail) })),
    finding:
      'Each of these journal lines, bank lines or document lines stores a CC1 other than the FNO its CC2 rolls up to through '
      + 'the current parent chain — usually written while the project was being moved. EVERY carrier is counted: a document '
      + 'line and the journal line it posted are two rows here, and an un-allocated bank line beside them a third, so count '
      + 'and amount measure the tagging to repair, not money at stake. Re-tag the journal line (tag_journal_lines), re-save '
      + 'the document, or move the project back.',
  };
}
