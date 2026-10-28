/**
 * CSV and XLSX of the tracking report (budgets P3 spec §2.8). Serialises the
 * rows `statementRows/budgetTrackingRows` makes for the screen, so the export
 * and the page print one set of figures: nothing is computed here, every
 * cell is a copied figure or blank. Section rows are skipped exactly as the
 * grid skips them (`NON_FIGURE_KINDS`); an absent figure is an empty cell,
 * never 0; text in the CSV goes through `csvVal` (formula injection).
 */
import ExcelJS from 'exceljs';
import { csvVal } from '@/lib/csv';
import { toBudgetTrackingRows, type BudgetTrackingRow } from '@/modules/accounting/services/reports/statementRows/budgetTrackingRows';
import { NON_FIGURE_KINDS } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { BudgetTrackingReport, TrackingMemberRef } from './trackingTypes';

export const TRACKING_EXPORT_COLUMNS = [
  'Code', 'Account', 'Band', 'Actual', 'Budget', 'Var R', 'Var %', 'Favourable', 'Projected FY', 'FY budget', 'Proj. var R', 'Unallocated budget',
] as const;

/** One printed row: text, then named figures (null = blank). */
export interface TrackingExportRow {
  code: string;
  account: string;
  band: string;
  actual: number;
  budget: number | null;
  variance: number | null;
  variancePct: number | null;
  favourable: 'Y' | 'N' | '';
  projected: number;
  fyBudget: number | null;
  projVariance: number | null;
  unallocated: number;
}

const pct2 = (n: number | undefined): number | null => (n === undefined ? null : Math.round(n * 100) / 100);

function exportRow(r: BudgetTrackingRow, band: string): TrackingExportRow {
  const b = r.budget;
  const p = r.projection;
  return {
    code: r.accountCode ?? '',
    account: r.label,
    band,
    actual: r.actual,
    budget: b.absent ? null : b.value,
    variance: b.absent || b.variance === undefined ? null : b.variance,
    variancePct: b.absent ? null : pct2(b.variancePct),
    favourable: b.absent || b.favourable === undefined ? '' : b.favourable ? 'Y' : 'N',
    projected: p.projected,
    fyBudget: p.absent || p.fyBudget === undefined ? null : p.fyBudget,
    projVariance: p.absent || p.variance === undefined ? null : p.variance,
    unallocated: r.unallocatedBudget,
  };
}

/** The printed rows, in screen order, section rows left out. */
export function trackingExportRows(report: Pick<BudgetTrackingReport, 'lines' | 'bands'>): TrackingExportRow[] {
  const out: TrackingExportRow[] = [];
  let band = '';
  for (const r of toBudgetTrackingRows(report)) {
    if (r.kind === 'section') band = r.label;
    if (NON_FIGURE_KINDS.has(r.kind)) continue;
    out.push(exportRow(r, r.kind === 'line' || r.kind === 'subtotal' ? band : r.label));
  }
  return out;
}

const member = (m: TrackingMemberRef | undefined, level: string) => (m ? `${level} ${m.code} ${m.name}` : null);

/** The leading label / value lines: company, window, version, filter, projection cutoff. */
export function trackingExportHeader(report: BudgetTrackingReport, companyName: string): Array<[string, string]> {
  const w = report.window;
  const f = report.filter;
  const filter = [member(f.cc1, 'CC1'), member(f.cc2, 'CC2'), member(f.bu, 'BU'), member(f.costCentre, 'Cost centre')].filter(Boolean).join('; ');
  const version = report.version ? `${report.version.name} · ${report.version.status}` : `None (no budget for FY${w.fiscalYear})`;
  return [
    ['Company', companyName],
    ['Window', w.notStarted ? `${w.label} (not started)` : `${w.label} (${w.startDate} to ${w.endDate})`],
    ['Version', version],
    ['Dimension filter', filter === '' ? 'None (company total)' : filter],
    ['Projection cutoff', `Actuals to ${report.projection.cutoff}, budget after`],
  ];
}

const money = (n: number | null): string => (n === null ? '' : n.toFixed(2));

/**
 * The leading-character guard `csvVal` applies (`src/lib/csv.ts` keeps its copy private), for
 * XLSX text cells: ExcelJS stores a leading '=' as a string, but a spreadsheet app a user
 * re-saves or pastes from can still read it as a formula.
 */
const xlsxText = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function trackingCsv(report: BudgetTrackingReport, companyName: string): string {
  const out = trackingExportHeader(report, companyName).map(([k, v]) => `${csvVal(k)},${csvVal(v)}`);
  out.push('');
  out.push(TRACKING_EXPORT_COLUMNS.map((c) => csvVal(c)).join(','));
  for (const r of trackingExportRows(report)) {
    out.push([
      csvVal(r.code), csvVal(r.account), csvVal(r.band),
      money(r.actual), money(r.budget), money(r.variance), money(r.variancePct), csvVal(r.favourable),
      money(r.projected), money(r.fyBudget), money(r.projVariance), money(r.unallocated),
    ].join(','));
  }
  return out.join('\n');
}

const NUM_FMT = '#,##0.00';

export async function trackingXlsx(report: BudgetTrackingReport, companyName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget vs Actual');
  for (const [k, v] of trackingExportHeader(report, companyName)) {
    const row = ws.addRow([k, xlsxText(v)]);
    row.getCell(1).font = { bold: true };
  }
  ws.addRow([]);
  const head = ws.addRow([...TRACKING_EXPORT_COLUMNS]);
  head.font = { bold: true };
  for (const r of trackingExportRows(report)) {
    const row = ws.addRow([
      r.code === '' ? null : xlsxText(r.code), xlsxText(r.account), xlsxText(r.band), r.actual, r.budget, r.variance, r.variancePct,
      r.favourable === '' ? null : r.favourable, r.projected, r.fyBudget, r.projVariance, r.unallocated,
    ]);
    for (const col of [4, 5, 6, 9, 10, 11, 12]) row.getCell(col).numFmt = NUM_FMT;
    if (r.code === '') row.font = { bold: true };
  }
  ws.columns.forEach((c, i) => { c.width = i === 1 ? 36 : i < 3 ? 16 : 14; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
