// src/modules/accounting/services/afs/managementPackStatements.ts
// The management pack's Income Statement and Balance Sheet as statement tables, built from the same
// reports the Reports screens print (getIncomeStatement / getBalanceSheet): the pack reads their
// figures and computes none. Columns are the pack month and, as the comparison mode asks, the prior
// month and the same month a year earlier. Pure: the generator fetches the reports.
import { formatMoney } from '@/lib/money/formatMoney';
import type { BalanceSheetReport, IncomeStatementReport } from '../../types/gl.types';
import type { NoteContentTable, NoteTableRowKind } from './afsTypes';

export interface Line { accountCode: string; accountName: string; amount: number }

/** One printed column: its header and the report behind it. */
export interface StatementColumn<R> { label: string; report: R }

export interface GroupSpec<R> { heading: string; lines: (r: R) => Line[]; totalLabel: string; total: (r: R) => number; lineLabel?: (l: Line) => string }
export interface SubtotalSpec<R> { label: string; value: (r: R) => number; kind: 'subtotal' | 'total' }
export type Spec<R> = { group: GroupSpec<R> } | { subtotal: SubtotalSpec<R> };

const ISL = (xs: Array<{ accountCode: string; accountName: string; amount: number }>): Line[] => xs;
const BSL = (xs: Array<{ accountCode: string; accountName: string; balance: number }>): Line[] =>
  xs.map((x) => ({ accountCode: x.accountCode, accountName: x.accountName, amount: x.balance }));

const INCOME_SPEC: Spec<IncomeStatementReport>[] = [
  { group: { heading: 'Revenue', lines: (r) => ISL(r.revenue), totalLabel: 'Total revenue', total: (r) => r.totalRevenue } },
  { group: { heading: 'Cost of sales', lines: (r) => ISL(r.costOfSales), totalLabel: 'Total cost of sales', total: (r) => r.totalCostOfSales } },
  { subtotal: { label: 'Gross profit', value: (r) => r.grossProfit, kind: 'subtotal' } },
  { group: { heading: 'Other income', lines: (r) => ISL(r.otherIncome), totalLabel: 'Total other income', total: (r) => r.totalOtherIncome } },
  { group: { heading: 'Operating expenses', lines: (r) => ISL(r.operatingExpenses), totalLabel: 'Total operating expenses', total: (r) => r.totalOperatingExpenses } },
  { subtotal: { label: 'Operating profit', value: (r) => r.operatingProfit, kind: 'subtotal' } },
  { group: { heading: 'Other expenses', lines: (r) => ISL(r.otherExpenses), totalLabel: 'Total other expenses', total: (r) => r.totalOtherExpenses } },
  { subtotal: { label: 'Net profit', value: (r) => r.netProfit, kind: 'total' } },
];

const BALANCE_SPEC: Spec<BalanceSheetReport>[] = [
  { group: { heading: 'Assets', lines: (r) => BSL(r.assets), totalLabel: 'Total assets', total: (r) => r.totalAssets } },
  { group: { heading: 'Liabilities', lines: (r) => BSL(r.liabilities), totalLabel: 'Total liabilities', total: (r) => r.totalLiabilities } },
  { group: { heading: 'Equity', lines: (r) => BSL(r.equity), totalLabel: 'Total equity', total: (r) => r.totalEquity } },
  { subtotal: { label: 'Total liabilities and equity', value: (r) => r.totalLiabilities + r.totalEquity, kind: 'total' } },
];

export interface Built { rows: string[][]; kinds: NoteTableRowKind[]; empty: boolean }

/** Account lines of a group across every column, in first-seen order (the pack month's accounts first). */
function unionLines<R>(group: GroupSpec<R>, columns: StatementColumn<R>[]): Line[] {
  const seen = new Map<string, Line>();
  for (const { report } of columns) {
    for (const line of group.lines(report)) if (!seen.has(line.accountCode)) seen.set(line.accountCode, line);
  }
  return [...seen.values()];
}

export function build<R>(spec: Spec<R>[], columns: StatementColumn<R>[], change: boolean): Built {
  const rows: string[][] = [];
  const kinds: NoteTableRowKind[] = [];
  let anyLine = false;
  // The change column is the pack month less the LAST column (the same month a year earlier).
  const cells = (values: number[]): string[] => [
    ...values.map((v) => formatMoney(v)),
    ...(change ? [formatMoney((values[0] ?? 0) - (values[values.length - 1] ?? 0))] : []),
  ];
  const blank = columns.map(() => '').concat(change ? [''] : []);
  const push = (label: string, kind: NoteTableRowKind, values: string[]) => { rows.push([label, ...values]); kinds.push(kind); };

  for (const item of spec) {
    if ('subtotal' in item) {
      const { label, value, kind } = item.subtotal;
      push(label, kind, cells(columns.map((c) => value(c.report))));
      continue;
    }
    const { group } = item;
    const lines = unionLines(group, columns);
    if (lines.length === 0) continue;
    anyLine = true;
    push(group.heading, 'heading', blank);
    for (const line of lines) {
      const byCode = columns.map((c) => group.lines(c.report).find((l) => l.accountCode === line.accountCode)?.amount ?? 0);
      push(group.lineLabel ? group.lineLabel(line) : `${line.accountCode} ${line.accountName}`, 'line', cells(byCode));
    }
    push(group.totalLabel, 'subtotal', cells(columns.map((c) => group.total(c.report))));
  }
  return { rows, kinds, empty: !anyLine };
}

function table(headers: string[], built: Built): NoteContentTable {
  return { type: 'table', headers, rows: built.rows, rowKinds: built.kinds };
}

export interface StatementTable { table: NoteContentTable; empty: boolean }

/** The pack month first; `changeOnLastYear` adds the pack month less the last column, which must then be the year-earlier one. */
export function incomeStatementTable(columns: StatementColumn<IncomeStatementReport>[], changeOnLastYear: boolean): StatementTable {
  const built = build(INCOME_SPEC, columns, changeOnLastYear);
  const headers = ['', ...columns.map((c) => c.label), ...(changeOnLastYear ? ['Change on last year'] : [])];
  return { table: table(headers, built), empty: built.empty };
}

export function balanceSheetTable(columns: StatementColumn<BalanceSheetReport>[], changeOnLastYear: boolean): StatementTable {
  const built = build(BALANCE_SPEC, columns, changeOnLastYear);
  const headers = ['', ...columns.map((c) => c.label), ...(changeOnLastYear ? ['Change on last year'] : [])];
  return { table: table(headers, built), empty: built.empty };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-08-31" -> "31 August 2026"; a value that is not a date stays as written. */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}
