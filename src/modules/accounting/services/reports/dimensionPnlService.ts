/**
 * P&L by dimension — one column per CC1 / CC2 / BU member plus an UNTAGGED
 * column, so the columns PARTITION the ungrouped P&L and tie to it to the cent.
 * The queries are here; the fold, columns and residual are dimensionPnlColumns.ts.
 *
 * One query, grouped by account and member, is the single source for both
 * consumers: `profit_and_loss` folds it through `aggregateFigures` per column,
 * and the income-statement page / xlsx matrix bands it per account.
 *
 * WHY UNTAGGED IS A COLUMN, NOT A FOOTNOTE. A line with no member is still P&L.
 * Dropping it would make the columns sum to less than the statement, and the
 * gap would read as a reconciliation difference rather than as untagged spend.
 * A member id that resolves to no master row of this company (a legacy line
 * from before the masters existed) keeps its own column, labelled unknown —
 * merged into untagged it would hide a tag that IS there.
 *
 * ONE CC1: `jl.cc1_id`. The legacy `cost_center_id` is read by no report.
 * `tag_journal_lines` rewrites cc1_id only, so a report that read the legacy
 * column too — as an alternative, or as a COALESCE fallback — counted a
 * re-tagged line under its old FNO, or brought back a CC1 that was cleared.
 * Nothing tagged is lost: the production census (2026-10-10, read-only) found
 * 4 lines with a legacy id — 2 equal to their cc1_id, 2 re-tagged, none with
 * the legacy id alone — and the writers that used to set only the legacy id
 * now put the picked centre in its slot (gl/dimensions/costCentrePick). Every
 * CC1 filter and the cc1 grouping use cc1_id — here, the income statement, the
 * classification coverage, the trial balance, the balance sheet, the ledger
 * drill-downs and the GL-line export — so a cost-centre filter and the cc1
 * column of the same member always agree. `cost_centre_id` matches cc1_id OR
 * cc2_id, so filtering on an FNO returns every line tagged to it at either
 * level.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { ClassifiedFigures } from '@/modules/accounting/services/gl/accountClassification';
import {
  buildDimensionPnl,
  foldFigures,
  unknownMember,
  type DimensionAccountRow,
  type DimensionFilter,
  type DimensionGroupBy,
  type DimensionMember,
  type DimensionPnl,
} from './dimensionPnlColumns';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Period P&L movement grouped by account and (when `groupBy` is set) member.
 * Only revenue and expense accounts: every P&L band reads those two types
 * alone, so the ungrouped fold of these rows equals the P&L of
 * `getFinancialFigures` for the same window.
 */
export async function fetchDimensionAccountRows(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  groupBy: DimensionGroupBy | null,
  filter: DimensionFilter = {},
): Promise<DimensionAccountRow[]> {
  const g = groupBy ?? null;
  const ccId = filter.costCentreId ?? null;
  const buId = filter.businessUnitId ?? null;
  const projId = filter.projectId ?? null;
  // The member column is chosen by a CASE over a bound value, never by
  // interpolating an identifier: `groupBy` is validated by the caller, but SQL
  // built from it would make that validation the only thing between an
  // argument and the query text.
  const rows = (await sql`
    SELECT ga.id AS account_id, ga.account_code, ga.account_name,
           ga.account_type, ga.account_subtype,
           CASE ${g}::TEXT
             WHEN 'cc1' THEN jl.cc1_id
             WHEN 'cc2' THEN jl.cc2_id
             WHEN 'bu'  THEN jl.bu_id
           END AS member_id,
           COALESCE(SUM(jl.debit), 0)  AS total_debit,
           COALESCE(SUM(jl.credit), 0) AS total_credit,
           COUNT(*) AS line_count
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
      AND ga.account_type IN ('revenue', 'expense')
      AND (${ccId}::TEXT IS NULL OR jl.cc1_id = ${ccId}::UUID
        OR jl.cc2_id = ${ccId}::UUID)
      AND (${buId}::TEXT IS NULL OR jl.bu_id = ${buId}::UUID)
      AND (${projId}::TEXT IS NULL OR jl.project_id = ${projId}::UUID)
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype, 6
    ORDER BY ga.account_code
  `) as DbRow[];

  return rows.map((r) => ({
    accountId: String(r.account_id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type) === 'revenue' ? 'revenue' : 'expense',
    accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
    memberId: r.member_id == null ? null : String(r.member_id),
    debit: num(r.total_debit),
    credit: num(r.total_credit),
    lineCount: num(r.line_count),
  }));
}

/**
 * Code and name of every member id present, from this company's masters only.
 * An id with no master row is reported as unknown rather than dropped.
 */
export async function resolveDimensionMembers(
  companyId: string,
  groupBy: DimensionGroupBy,
  memberIds: readonly string[],
): Promise<Map<string, DimensionMember>> {
  const out = new Map<string, DimensionMember>();
  if (memberIds.length > 0) {
    const ids = [...new Set(memberIds)];
    const rows = (groupBy === 'bu'
      ? await sql`
          SELECT bu.id, bu.code, bu.name, NULL::TEXT AS parent_code
          FROM business_units bu
          WHERE bu.company_id = ${companyId}::UUID AND bu.id = ANY(${ids}::UUID[])
        `
      : await sql`
          SELECT cc.id, cc.code, cc.name, p.code AS parent_code
          FROM cost_centres cc
          LEFT JOIN cost_centres p ON p.id = cc.parent_id AND p.company_id = ${companyId}::UUID
          WHERE cc.company_id = ${companyId}::UUID AND cc.id = ANY(${ids}::UUID[])
        `) as DbRow[];
    for (const r of rows) {
      const id = String(r.id);
      out.set(id, {
        key: id,
        memberId: id,
        code: String(r.code),
        name: String(r.name),
        parentCode: r.parent_code == null ? null : String(r.parent_code),
      });
    }
    for (const id of ids) {
      if (!out.has(id)) out.set(id, unknownMember(id));
    }
  }
  return out;
}

/** Group already-fetched rows: resolve their members and build the columns. */
export async function dimensionPnlOf(
  companyId: string,
  groupBy: DimensionGroupBy,
  rows: readonly DimensionAccountRow[],
): Promise<DimensionPnl> {
  const ids = rows.map((r) => r.memberId).filter((id): id is string => id !== null);
  const members = await resolveDimensionMembers(companyId, groupBy, ids);
  return buildDimensionPnl(groupBy, rows, members);
}

/** Fetch, resolve and group in one call. */
export async function getDimensionPnl(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  groupBy: DimensionGroupBy,
  filter: DimensionFilter = {},
): Promise<DimensionPnl> {
  const rows = await fetchDimensionAccountRows(companyId, periodStart, periodEnd, groupBy, filter);
  return dimensionPnlOf(companyId, groupBy, rows);
}

/** Ungrouped P&L figures restricted by a dimension filter. */
export async function getFilteredPeriodFigures(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  filter: DimensionFilter,
): Promise<ClassifiedFigures> {
  return foldFigures(await fetchDimensionAccountRows(companyId, periodStart, periodEnd, null, filter));
}
