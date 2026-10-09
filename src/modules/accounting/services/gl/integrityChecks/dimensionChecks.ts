/**
 * Integrity checks over the CC1 / CC2 analysis dimensions.
 *
 * A line that carries a project (CC2) stores the FNO (CC1) that was derived
 * from the project's parent chain when the line was written. Moving a project
 * to another FNO is refused while anything carries it (dimensionMasterEdit),
 * but journal posting does not take the master lock, so a line committed while
 * the move was being planned can still keep the old FNO. That race is closed by
 * detection, not by locking (Hein, 2026-10-09): this check finds every line
 * whose stored CC1 is not the FNO its CC2 derives TODAY.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { num, r2, str, type IntegrityCheckContext, type IntegrityCheckResult } from './types';

/** The same bound as dimensionDerivation.deriveFnoId. */
const MAX_DEPTH = 16;

/**
 * Journal and bank lines whose CC1 is not the FNO their CC2 derives now.
 *
 * The derivation mirrors deriveFnoId: walk the CC2's parents, company-scoped,
 * to the first CC1; a cycle, a missing parent or no CC1 at all derives none.
 * IS DISTINCT FROM, so a line that stores no CC1 under a project that now
 * derives one is flagged, and a line that stores a CC1 under a project that
 * derives none is flagged too. Removed bank-feed rows are out of scope;
 * pending ones are not — their selection is what allocation copies to the ledger.
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
      LEFT JOIN derived d ON d.cc2_id = jl.cc2_id
      WHERE jl.company_id = ${ctx.companyId}::UUID AND jl.cc2_id IS NOT NULL
        AND je.entry_date <= ${ctx.asAt}::DATE
        AND jl.cc1_id IS DISTINCT FROM d.fno_id
      UNION ALL
      SELECT bt.id::TEXT, COALESCE(bt.reference, bt.description, bt.id::TEXT),
             ABS(bt.amount), 'bank line', bt.cc1_id, bt.cc2_id, d.fno_id
      FROM bank_transactions bt
      LEFT JOIN derived d ON d.cc2_id = bt.cc2_id
      WHERE bt.company_id = ${ctx.companyId}::UUID AND bt.cc2_id IS NOT NULL
        AND bt.feed_state <> 'removed'
        AND bt.transaction_date <= ${ctx.asAt}::DATE
        AND bt.cc1_id IS DISTINCT FROM d.fno_id
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
      'Each of these lines stores a CC1 other than the FNO its CC2 rolls up to through the current parent chain — usually a line '
      + 'committed while the project was being moved. FNO reports split its figure from the project\'s. Re-tag the line (tag_journal_lines) '
      + 'or move the project back.',
  };
}
