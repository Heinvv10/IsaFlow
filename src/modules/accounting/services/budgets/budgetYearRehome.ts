/**
 * Budget months across a change of year end (decision 12, migration 947).
 *
 * A version belongs to a financial-year LABEL and the readers count only the months inside that
 * year, so when a change of year end (or its undo) moves a month into another year, the month's
 * amounts must move with it or they silently stop counting. The PRIMARY version's months move into
 * the primary of the year that now holds them (a draft 'Original' is created for a year with none),
 * in the same transaction as the change. A month in a locked version or in a non-primary version
 * has nowhere certain to go, so the change is refused up front until it is unlocked, or the version
 * is re-homed or deleted by hand.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fiscalYearForDate } from '../gl/fiscalYearRegistry';
import { auditBudgetWrite, lockVersionForWrite, resolvePrimaryVersion } from './budgetVersionScope';
import { BudgetVersionError } from './budgetVersionTypes';

/**
 * Why a change whose months after `boundary` change year cannot carry the budget with it (empty:
 * it can). `fromLabel` is the year being changed: a locked budget of it or of a later year could
 * have to receive or give up months, so it is refused too, before anything is written.
 */
export async function budgetRehomeRefusals(companyId: string, boundary: string, fromLabel: number): Promise<string[]> {
  const rows = (await sql`
    SELECT v.fiscal_year, v.name, v.status, v.is_primary, COUNT(bm.id)::int AS n
      FROM budget_versions v
      LEFT JOIN budget_month_amounts bm ON bm.version_id = v.id AND bm.company_id = v.company_id
       AND (bm.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE > ${boundary}::DATE
     WHERE v.company_id = ${companyId}::UUID
     GROUP BY v.id, v.fiscal_year, v.name, v.status, v.is_primary
    HAVING (v.status = 'locked' AND (v.fiscal_year >= ${fromLabel} OR COUNT(bm.id) > 0))
        OR (NOT v.is_primary AND COUNT(bm.id) > 0)
     ORDER BY v.fiscal_year, v.name
  `) as DbRow[];
  if (rows.length === 0) return [];
  const named = rows.map((r) => `FY${String(r.fiscal_year)} '${String(r.name)}' (${r.status === 'locked' ? 'locked' : `not the primary budget, ${String(r.n)} month amount(s) moving`})`);
  return [`Budgets would have to move between years with this change: ${named.join('; ')}. `
    + 'Unlock a locked budget, and delete a scenario or reforecast version (or its months after the change), before changing the year end.'];
}

/**
 * After the year registry has changed (same transaction): moves every PRIMARY version's month after
 * `boundary` that now lies in another year into that year's primary. Returns the rows moved. A
 * clash in the target (the same cell, or the account budgeted at another grain) aborts the change.
 */
export async function rehomePrimaryBudgetMonths(companyId: string, boundary: string, actor: string): Promise<number> {
  try {
    return await rehome(companyId, boundary, actor);
  } catch (err) {
    // A typed refusal is a 4xx, and a 4xx COMMITS the request: the year change written so far
    // would stay. Anything that stops the move here must roll the whole change back.
    if (err instanceof BudgetVersionError) throw new Error(`Change of year end aborted: ${err.message}`);
    throw err;
  }
}

async function rehome(companyId: string, boundary: string, actor: string): Promise<number> {
  const months = (await sql`
    SELECT DISTINCT bm.month::text AS month, v.id AS version_id, v.fiscal_year
      FROM budget_month_amounts bm
      JOIN budget_versions v ON v.id = bm.version_id AND v.company_id = bm.company_id AND v.is_primary
     WHERE bm.company_id = ${companyId}::UUID
       -- A month with any day after the boundary can change year.
       AND (bm.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE > ${boundary}::DATE
     ORDER BY 1
  `) as DbRow[];
  let moved = 0;
  for (const m of months) {
    const label = (await fiscalYearForDate(companyId, String(m.month))).fiscalYear;
    if (label === Number(m.fiscal_year)) continue;
    const source = String(m.version_id);
    const target = (await resolvePrimaryVersion(companyId, label, { create: true, actor }))!;
    // Lock order by id, as every multi-version writer must.
    for (const id of [source, target].sort()) await lockVersionForWrite(companyId, id);
    const clash = (await sql`
      SELECT 1 FROM budget_month_amounts s
       WHERE s.company_id = ${companyId}::UUID AND s.version_id = ${source}::UUID AND s.month = ${String(m.month)}::DATE
         AND EXISTS (SELECT 1 FROM budget_month_amounts t
                      WHERE t.company_id = s.company_id AND t.version_id = ${target}::UUID AND t.gl_account_id = s.gl_account_id
                        AND (t.dim_grain <> s.dim_grain OR (t.month = s.month AND t.cc1_id IS NOT DISTINCT FROM s.cc1_id
                             AND t.cc2_id IS NOT DISTINCT FROM s.cc2_id AND t.bu_id IS NOT DISTINCT FROM s.bu_id)))
       LIMIT 1
    `) as DbRow[];
    if (clash[0]) {
      throw new Error(`Change of year end aborted: the budget for ${String(m.month).slice(0, 7)} cannot move into FY${label}, `
        + 'whose primary budget already holds that month or budgets the account at another level');
    }
    const r = (await sql`
      UPDATE budget_month_amounts SET version_id = ${target}::UUID
       WHERE company_id = ${companyId}::UUID AND version_id = ${source}::UUID AND month = ${String(m.month)}::DATE
      RETURNING id
    `) as DbRow[];
    moved += r.length;
    await auditBudgetWrite(companyId, actor, 'update', target, label, {
      rehomedFrom: source, fromFiscalYear: String(m.fiscal_year), month: String(m.month).slice(0, 7), amounts: String(r.length),
    });
  }
  return moved;
}
