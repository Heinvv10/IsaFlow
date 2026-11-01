/**
 * The Income Statement as a PDF, on the same two sources as the Excel export:
 * the band rows are `incomeStatementPackRows`, the one P&L row definition the
 * packs share, and every figure is the report's own. Nothing here adds up.
 *
 * `report.subtypeDisclosure` is printed directly beneath gross profit, because a
 * PDF leaves the app with no screen to qualify the margin. See
 * incomeStatementDisclosure.ts.
 *
 * Every amount prints through `formatStatementFigure`: a negative in brackets,
 * space separators, a nil (anything under half a cent) as an en dash. Margins
 * take the same bracket through `formatPctLevel`.
 *
 * No `group_by`: the route refuses it. This A4 portrait page at 9 pt takes 4
 * amount columns (182 mm less a 50 mm account column, at 28.9 mm for a bold
 * `(R 212 345 678.90)` before cell padding), and a dimension has as many
 * members as it has. Turning it landscape at 7 pt would reach only 10.
 */

import { formatPctLevel, formatStatementFigure } from '@/lib/format/money';
import { sql } from '@/lib/neon';
import type { IncomeStatementLineItem, IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';
import {
  fmtDate,
  hexToRgb,
  renderPageFooters,
  COLORS,
  type CompanyDetails,
  type JsPdfDoc,
} from '../core/pdfShared';
import { reasonLabel } from './incomeStatementDisclosure';
import {
  incomeStatementPackRows,
  NO_MARGIN_CELL,
  type PackPandLBand,
  type PackPandLRow,
} from './incomeStatementPackRows';

type IncomeStatementPdfRow =
  | { kind: 'section'; label: string }
  | { kind: 'account'; code: string; label: string; amount: number }
  | { kind: 'band'; band: PackPandLBand; label: string; amount: number; margin?: number | null }
  | { kind: 'warning'; code?: string; label: string; amount: number }
  | { kind: 'note'; label: string };

const money = (amount: number): string => formatStatementFigure(amount, { cents: true, symbol: true, pack: true });

/** The screen's Net Profit row and the xlsx's; the packs keep their own label. */
const NET_PROFIT_LABEL = 'Net Profit / (Loss)';

/**
 * The report's totals under the names `incomeStatementPackRows` reads. A margin
 * prints only on positive turnover, as in the xlsx and CSV: the service keeps
 * one on negative turnover for the screen.
 */
function packSection(report: IncomeStatementReport): Record<string, unknown> {
  const hasMargin = report.totalRevenue > 0;
  return {
    revenue: report.totalRevenue,
    costOfSales: report.totalCostOfSales,
    grossProfit: report.grossProfit,
    otherIncome: report.totalOtherIncome,
    operatingExpenses: report.totalOperatingExpenses,
    operatingProfit: report.operatingProfit,
    otherExpenses: report.totalOtherExpenses,
    netProfit: report.netProfit,
    grossMargin: hasMargin ? report.grossMarginPct : null,
    netMargin: hasMargin ? report.netMarginPct : null,
  };
}

/**
 * The pack rows omit a nil optional band. Accounts that net to nil are still on
 * the statement, so here the band stays, at its reconciling place.
 */
function bandRows(report: IncomeStatementReport): PackPandLRow[] {
  const rows = incomeStatementPackRows(packSection(report));
  const keep = (key: PackPandLBand, label: string, after: PackPandLBand, items: IncomeStatementLineItem[]) => {
    if (items.length === 0 || rows.some((r) => r.key === key)) return;
    rows.splice(rows.findIndex((r) => r.key === after) + 1, 0, { key, label, amount: 0 });
  };
  keep('otherIncome', 'Other Income', 'grossProfit', report.otherIncome);
  keep('otherExpenses', 'Other Expenses', 'operatingProfit', report.otherExpenses);
  return rows.map((row) => (row.key === 'netProfit' ? { ...row, label: NET_PROFIT_LABEL } : row));
}

function disclosureRows(report: IncomeStatementReport): IncomeStatementPdfRow[] {
  const d = report.subtypeDisclosure;
  if (!d) return [];
  return [
    // Two rows, never their sum: see incomeStatementDisclosure.ts.
    { kind: 'warning', label: 'Expense that could be cost of sales (at most)', amount: d.costOfSalesExposureAtMost },
    { kind: 'warning', label: 'Revenue that could be other income (at most)', amount: d.otherIncomeExposureAtMost },
    ...d.notices.map((label): IncomeStatementPdfRow => ({ kind: 'note', label })),
    ...d.accounts.map((a): IncomeStatementPdfRow => ({
      kind: 'warning', code: a.accountCode, label: `${a.accountName} — ${reasonLabel(a.reason)}`, amount: a.amount,
    })),
    ...(d.unnamedAccounts > 0
      ? [{ kind: 'note' as const, label: `and ${d.unnamedAccounts} further affected account(s)` }]
      : []),
    { kind: 'note', label: 'The amounts above are repeated elsewhere in this statement — do not add them again.' },
  ];
}

/** The statement, top to bottom. Exported so the row list is testable without a PDF. */
export function incomeStatementPdfRows(report: IncomeStatementReport): IncomeStatementPdfRow[] {
  const accounts: Partial<Record<PackPandLBand, IncomeStatementLineItem[]>> = {
    revenue: report.revenue,
    costOfSales: report.costOfSales,
    otherIncome: report.otherIncome,
    operatingExpenses: report.operatingExpenses,
    otherExpenses: report.otherExpenses,
  };
  return bandRows(report).flatMap((row): IncomeStatementPdfRow[] => {
    const items = accounts[row.key] ?? [];
    return [
      ...(items.length > 0 ? [{ kind: 'section' as const, label: row.label }] : []),
      ...items.map((item): IncomeStatementPdfRow => ({
        kind: 'account', code: item.accountCode, label: item.accountName, amount: item.amount,
      })),
      {
        kind: 'band', band: row.key, label: items.length > 0 ? `Total ${row.label}` : row.label,
        amount: row.amount, margin: row.margin,
      },
      ...(row.key === 'grossProfit' ? disclosureRows(report) : []),
    ];
  });
}

const marginCell = (margin: number | null | undefined): string =>
  margin === undefined ? '' : margin === null ? NO_MARGIN_CELL : formatPctLevel(margin);

function tableRow(row: IncomeStatementPdfRow, accent: [number, number, number]): unknown[] {
  const AMBER = { textColor: COLORS.AMBER };
  const right = { halign: 'right' };
  switch (row.kind) {
    case 'section':
      return [{ content: row.label, colSpan: 4, styles: { fontStyle: 'bold', textColor: accent } }];
    case 'account':
      return [row.code, row.label, { content: money(row.amount), styles: right }, ''];
    case 'band': {
      const styles = { fontStyle: 'bold', fillColor: COLORS.SURFACE };
      return [
        { content: row.label, colSpan: 2, styles },
        { content: money(row.amount), styles: { ...styles, ...right } },
        { content: marginCell(row.margin), styles: { ...styles, ...right } },
      ];
    }
    case 'warning':
      return [
        { content: row.code ?? '', styles: AMBER },
        { content: row.label, styles: AMBER },
        { content: money(row.amount), styles: { ...AMBER, ...right } },
        '',
      ];
    case 'note':
      return [{ content: row.label, colSpan: 4, styles: { ...AMBER, fontStyle: 'italic' } }];
  }
}

const COMPARATOR_LABELS = { prior: 'Prior period', budget: 'Budget', variance: 'Variance', trend: '12-month trend' } as const;
type Comparator = keyof typeof COMPARATOR_LABELS;

/** `comparators=prior,budget,variance,trend`, any of them: the columns the screen had on. Null when it names anything else. */
export function parseComparators(value: unknown): Comparator[] | null {
  if (value === undefined) return [];
  if (typeof value !== 'string') return null;
  const names = value.split(',');
  return names.every((n): n is Comparator => Object.keys(COMPARATOR_LABELS).includes(n)) ? [...new Set(names)] : null;
}

interface IncomeStatementPdfOptions {
  /** The filter the figures were read under; a filtered statement must say so. */
  scope: string | null;
  /** YYYY-MM-DD. */
  generatedOn: string;
  /** Columns the screen shows and this PDF does not: the reader of the PDF cannot see that they are gone. */
  omittedComparators?: readonly Comparator[];
}

export async function buildIncomeStatementPdf(
  report: IncomeStatementReport,
  company: CompanyDetails,
  { scope, generatedOn, omittedComparators = [] }: IncomeStatementPdfOptions,
): Promise<Buffer> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc: JsPdfDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW: number = doc.internal.pageSize.getWidth();
  const pageH: number = doc.internal.pageSize.getHeight();
  const margin = 14;
  const { r, g, b } = hexToRgb(company.primaryColor);
  const accent: [number, number, number] = [r, g, b];

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...COLORS.TEXT_PRIMARY);
  const nameLines: string[] = doc.splitTextToSize(company.name, pageW - margin * 2);
  doc.text(nameLines, margin, 18);
  let y = 18 + nameLines.length * 6;

  doc.setFontSize(11);
  doc.setTextColor(...accent);
  doc.text('Income Statement', margin, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  const meta = [
    `Period: ${fmtDate(report.periodStart)} to ${fmtDate(report.periodEnd)}`,
    ...(scope ? [scope] : []),
    ...(omittedComparators.length > 0
      ? [`Comparators on screen, not included in this PDF: ${omittedComparators.map((c) => COMPARATOR_LABELS[c]).join(', ')}.`]
      : []),
    `Generated: ${fmtDate(generatedOn)}`,
  ];
  for (const lineText of meta.flatMap((m): string[] => doc.splitTextToSize(m, pageW - margin * 2))) {
    doc.text(lineText, margin, y);
    y += 4.5;
  }

  autoTable(doc, {
    head: [['Code', 'Account', { content: 'Amount', styles: { halign: 'right' } }, { content: 'Margin', styles: { halign: 'right' } }]],
    // autoTable's row type wants its own cell shape; `tableRow` builds exactly that.
    body: incomeStatementPdfRows(report).map((row) => tableRow(row, accent)) as never,
    startY: y + 2,
    margin: { left: margin, right: margin, bottom: 18 },
    styles: { fontSize: 9, cellPadding: 1.8 },
    headStyles: { fillColor: accent, textColor: COLORS.WHITE, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 22 }, 2: { cellWidth: 36 }, 3: { cellWidth: 18 } },
    rowPageBreak: 'avoid',
  });

  renderPageFooters(doc, pageW, pageH, margin, `${company.name} — Income Statement`);
  return Buffer.from(doc.output('arraybuffer'));
}

/**
 * The line a filtered statement carries, or null when it is the whole company.
 * Both lookups are by company: an id from elsewhere prints as unknown, never
 * under the other company's name.
 */
export async function incomeStatementScopeLabel(
  companyId: string,
  costCentreId: string | undefined,
  businessUnitId: string | undefined,
): Promise<string | null> {
  const parts: string[] = [];
  const named = (rows: unknown, fallback: string): string => {
    const row = (rows as Array<{ code: string; name: string }>)[0];
    return row ? `${row.code} — ${row.name}` : fallback;
  };
  if (costCentreId) {
    const rows = await sql`
      SELECT code, name FROM cost_centres WHERE id = ${costCentreId}::UUID AND company_id = ${companyId}::UUID`;
    parts.push(`Cost centre: ${named(rows, 'unknown')}`);
  }
  if (businessUnitId) {
    const rows = await sql`
      SELECT code, name FROM business_units WHERE id = ${businessUnitId}::UUID AND company_id = ${companyId}::UUID`;
    parts.push(`Business unit: ${named(rows, 'unknown')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
