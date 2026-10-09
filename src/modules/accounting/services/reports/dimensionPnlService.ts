/**
 * P&L by dimension — one column per CC1 / CC2 / BU member plus an UNTAGGED
 * column, so the columns PARTITION the ungrouped P&L and tie to it to the cent.
 *
 * One query, grouped by account and member, is the single source for both
 * consumers: `profit_and_loss` folds it through `aggregateFigures` per column,
 * and the income-statement page / xlsx matrix bands it per account. Bands come
 * from `expenseBand` / `revenueBand`, the same functions both surfaces already
 * use (B75), so a grouped column can never be banded differently from the
 * ungrouped statement it sits beside.
 *
 * WHY UNTAGGED IS A COLUMN, NOT A FOOTNOTE. A line with no member is still P&L.
 * Dropping it would make the columns sum to less than the statement, and the
 * gap would read as a reconciliation difference rather than as untagged spend.
 * A member id that resolves to no master row of this company (a legacy line
 * from before the masters existed) keeps its own column, labelled unknown —
 * merged into untagged it would hide a tag that IS there.
 *
 * THE COST-CENTRE FILTER. `cost_centre_id` matches the legacy `cost_center_id`
 * OR `cc1_id` OR `cc2_id` — the same predicate `getIncomeStatement` has always
 * used — so filtering on an FNO returns every line tagged to it at either level.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import {
  aggregateFigures,
  expenseBand,
  revenueBand,
  type ClassificationRow,
  type ClassifiedFigures,
} from '@/modules/accounting/services/gl/accountClassification';

export const DIMENSION_GROUP_BYS = ['cc1', 'cc2', 'bu'] as const;
export type DimensionGroupBy = (typeof DIMENSION_GROUP_BYS)[number];

export function isDimensionGroupBy(v: unknown): v is DimensionGroupBy {
  return typeof v === 'string' && (DIMENSION_GROUP_BYS as readonly string[]).includes(v);
}

export interface DimensionFilter {
  /** Matches cost_center_id OR cc1_id OR cc2_id. */
  costCentreId?: string;
  businessUnitId?: string;
  projectId?: string;
}

/** The key of the untagged column in every map this module returns. */
export const UNTAGGED_KEY = 'untagged';

/** One account × member row of period movement. */
export interface DimensionAccountRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  accountSubtype: string | null;
  /** Member id, or null for an untagged line. */
  memberId: string | null;
  debit: number;
  credit: number;
  lineCount: number;
}

export interface DimensionMember {
  /** Member id, or `untagged`. */
  key: string;
  memberId: string | null;
  code: string;
  name: string;
  /** CC2 only: the parent cost centre's code (its CC1 or programme). */
  parentCode: string | null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

export function memberKey(memberId: string | null): string {
  return memberId ?? UNTAGGED_KEY;
}

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
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
      AND ga.account_type IN ('revenue', 'expense')
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID
        OR jl.cc1_id = ${ccId}::UUID OR jl.cc2_id = ${ccId}::UUID)
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
          LEFT JOIN cost_centres p ON p.id = cc.parent_id AND p.company_id = cc.company_id
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

function unknownMember(id: string): DimensionMember {
  return { key: id, memberId: id, code: 'UNKNOWN', name: `Unknown member ${id}`, parentCode: null };
}

export const UNTAGGED_MEMBER: DimensionMember = {
  key: UNTAGGED_KEY,
  memberId: null,
  code: 'UNTAGGED',
  name: 'Untagged',
  parentCode: null,
};

/** Fold rows into ClassifiedFigures — each account row counts as one account. */
export function foldFigures(rows: readonly DimensionAccountRow[]): ClassifiedFigures {
  const asClassification: ClassificationRow[] = rows.map((r) => ({
    account_type: r.accountType,
    account_subtype: r.accountSubtype,
    debit: r.debit,
    credit: r.credit,
    account_count: 1,
  }));
  return aggregateFigures(asClassification);
}

/** The P&L bands a dimension column carries. */
export const PNL_BANDS = [
  'turnover',
  'otherIncome',
  'costOfSales',
  'grossProfit',
  'operatingExpenses',
  'depreciation',
  'operatingProfit',
  'otherExpenses',
  'netProfit',
] as const;
export type PnlBand = (typeof PNL_BANDS)[number];
export type PnlBands = Record<PnlBand, number>;

export function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

export function bandsOf(f: ClassifiedFigures): PnlBands {
  return {
    turnover: round2(f.revenue),
    otherIncome: round2(f.otherIncome),
    costOfSales: round2(f.costOfSales),
    grossProfit: round2(f.grossProfit),
    operatingExpenses: round2(f.operatingExpenses),
    depreciation: round2(f.depreciation),
    operatingProfit: round2(f.operatingProfit),
    otherExpenses: round2(f.otherExpenses),
    netProfit: round2(f.netProfit),
  };
}

export interface DimensionColumn extends DimensionMember, PnlBands {
  lineCount: number;
}

export interface DimensionPnl {
  groupBy: DimensionGroupBy;
  /** Tagged members, ordered by code, then the untagged column last. */
  columns: DimensionColumn[];
  /** The ungrouped P&L of the same rows. */
  total: PnlBands;
  /** total − Σ columns, per band, to the cent. Zero when the columns tie. */
  residual: PnlBands;
}

/**
 * Group the rows into one column per member plus untagged. Every row lands in
 * exactly one column, so Σ columns = total by construction; `residual` states
 * it per band rather than asking the reader to trust that.
 */
export function buildDimensionPnl(
  groupBy: DimensionGroupBy,
  rows: readonly DimensionAccountRow[],
  members: ReadonlyMap<string, DimensionMember>,
): DimensionPnl {
  const byKey = new Map<string, DimensionAccountRow[]>();
  for (const r of rows) {
    const k = memberKey(r.memberId);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }

  const columns: DimensionColumn[] = [];
  for (const [k, list] of byKey) {
    const member = k === UNTAGGED_KEY ? UNTAGGED_MEMBER : (members.get(k) ?? unknownMember(k));
    columns.push({
      ...member,
      ...bandsOf(foldFigures(list)),
      lineCount: list.reduce((s, r) => s + r.lineCount, 0),
    });
  }
  columns.sort(compareMembers);

  const total = bandsOf(foldFigures(rows));
  return { groupBy, columns, total, residual: residualOf(total, columns) };
}

/** Tagged members by code, untagged last. */
export function compareMembers(a: DimensionMember, b: DimensionMember): number {
  if (a.key === UNTAGGED_KEY) return b.key === UNTAGGED_KEY ? 0 : 1;
  if (b.key === UNTAGGED_KEY) return -1;
  return a.code.localeCompare(b.code) || a.key.localeCompare(b.key);
}

/**
 * `against − Σ columns`, per band, to the cent. `bands` narrows the check to
 * the bands `against` actually carries (the income-statement report has no
 * depreciation line); the others come back as zero.
 */
export function residualOf(
  against: PnlBands,
  columns: readonly PnlBands[],
  bands: readonly PnlBand[] = PNL_BANDS,
): PnlBands {
  const out = Object.fromEntries(PNL_BANDS.map((b) => [b, 0])) as PnlBands;
  for (const band of bands) {
    // In cents: summing rand amounts as floats can leave 1e-9 dust that would
    // print as a non-zero residual.
    const sumCents = columns.reduce((s, c) => s + Math.round(c[band] * 100), 0);
    out[band] = round2((Math.round(against[band] * 100) - sumCents) / 100);
  }
  return out;
}

export function isZeroResidual(r: PnlBands): boolean {
  return PNL_BANDS.every((b) => r[b] === 0);
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
  const ids = rows.map((r) => r.memberId).filter((id): id is string => id !== null);
  const members = await resolveDimensionMembers(companyId, groupBy, ids);
  return buildDimensionPnl(groupBy, rows, members);
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

export type StatementBand = 'revenue' | 'otherIncome' | 'costOfSales' | 'operatingExpenses' | 'otherExpenses';

/** Which statement band an account row belongs in — the income-statement matrix's row grouping. */
export function statementBandOf(
  r: Pick<DimensionAccountRow, 'accountType' | 'accountSubtype'>,
): StatementBand {
  if (r.accountType === 'revenue') {
    return revenueBand(r.accountSubtype) === 'other_income' ? 'otherIncome' : 'revenue';
  }
  switch (expenseBand(r.accountSubtype)) {
    case 'cost_of_sales': return 'costOfSales';
    case 'other_expense': return 'otherExpenses';
    default: return 'operatingExpenses';
  }
}
