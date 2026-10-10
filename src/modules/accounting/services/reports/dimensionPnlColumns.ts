/**
 * P&L by dimension — the pure half: member keys, the fold of account rows into
 * P&L bands, the columns, and the residual that states the tie. The queries
 * that feed it are in dimensionPnlService.ts.
 *
 * Bands come from `expenseBand` / `revenueBand` via `aggregateFigures`, the
 * same functions both P&L surfaces already use (B75), so a grouped column can
 * never be banded differently from the ungrouped statement it sits beside.
 */

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
  /**
   * Matches a line whose EFFECTIVE CC1 — COALESCE(cc1_id, cost_center_id) — or
   * whose CC2 is this id. See dimensionPnlService.ts.
   */
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

export function memberKey(memberId: string | null): string {
  return memberId ?? UNTAGGED_KEY;
}

export function unknownMember(id: string): DimensionMember {
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
