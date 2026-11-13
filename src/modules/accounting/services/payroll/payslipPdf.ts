/**
 * Payslip PDF (wave 4 PS): one A4 page per employee, rendered in memory from
 * `getPayslips` and returned as a Buffer. Nothing is written to disk.
 *
 * BCEA s33(1) particulars: the employer's name and address ("Employer address not
 * recorded", in red on a final slip, when none is on file); the employee's name, and
 * the occupation from the employee profile ("Occupation not recorded" when none); the period paid for;
 * the remuneration in money; each deduction; the actual amount paid; the stored ordinary hours and rate
 * (`payslipFacts`), with overtime "not recorded" until payroll captures it. Dates and money use the app's formats.
 *
 * No ID number; the bank account as its last four digits only. A run that is not final
 * (the R-035 guard) carries the DRAFT line and the faint DRAFT mark on EVERY page, drawn
 * after layout so a slip that flows onto more pages carries them too.
 */
import { COLORS, type JsPdfDoc } from '@/modules/accounting/services/core/pdfShared';
import { cleanAddress, money, particulars, shortDate } from './payslipFacts';
import { BENEFIT_NOTE, notItemisedNote, PAID_DIRECTLY_NOTE, type PayslipItem } from './payslipItems';
import type { Payslip, PayslipRun } from './payslipModel';

export const DRAFT_MARK = 'DRAFT: this run is not approved';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MARGIN = 14;
/** Top margin for tables that flow onto a new page: below the DRAFT line at y = 10. */
const TOP = 16;
const round2 = (n: number): number => Math.round(n * 100) / 100;

type AutoTable = (doc: JsPdfDoc, opts: Record<string, unknown>) => void;

const pad = (n: number) => String(n).padStart(2, '0');

export function payPeriodLabel(month: number, year: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${shortDate(`${year}-${pad(month)}-01`)} to ${shortDate(`${year}-${pad(month)}-${pad(last)}`)}`;
}

const itemRow = (i: PayslipItem): string[] => [i.code ? `${i.label} (${i.code})` : i.label, money(i.amount)];

function lastY(doc: JsPdfDoc, fallback: number): number {
  return (doc as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? fallback;
}

function table(doc: JsPdfDoc, autoTable: AutoTable, y: number, title: string, rows: string[][], total?: [string, number]): number {
  autoTable(doc, {
    head: [[title, { content: 'Amount', styles: { halign: 'right' } }]],
    body: rows.map(([label, amount]) => [label, { content: amount, styles: { halign: 'right' } }]),
    foot: total ? [[total[0], { content: money(total[1]), styles: { halign: 'right' } }]] : undefined,
    startY: y,
    margin: { top: TOP, left: MARGIN, right: MARGIN },
    styles: { fontSize: 9, cellPadding: 1.6, textColor: COLORS.TEXT_PRIMARY },
    headStyles: { fillColor: COLORS.SURFACE, textColor: COLORS.TEXT_PRIMARY, fontStyle: 'bold' },
    footStyles: { fillColor: COLORS.WHITE, textColor: COLORS.TEXT_PRIMARY, fontStyle: 'bold' },
    columnStyles: { 1: { cellWidth: 40 } },
  });
  return lastY(doc, y) + 4;
}

/** The DRAFT line at the top and the faint mark across the page, on every page of the document. */
function draftEveryPage(doc: JsPdfDoc): void {
  const pageW: number = doc.internal.pageSize.getWidth();
  const pageH: number = doc.internal.pageSize.getHeight();
  for (let page = 1; page <= doc.getNumberOfPages(); page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...COLORS.DANGER);
    doc.text(DRAFT_MARK, MARGIN, 10);
    draftMark(doc, pageW, pageH);
  }
}

/** Across the page, faint enough that the figures under it stay legible. */
function draftMark(doc: JsPdfDoc, pageW: number, pageH: number): void {
  doc.saveGraphicsState();
  doc.setGState(new doc.GState({ opacity: 0.18 }));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(30);
  doc.setTextColor(...COLORS.DANGER);
  doc.text(DRAFT_MARK, pageW / 2, pageH / 2, { align: 'center', angle: 30 });
  doc.restoreGraphicsState();
}

function heading(doc: JsPdfDoc, run: PayslipRun, slip: Payslip, pageW: number): number {
  doc.setTextColor(...COLORS.TEXT_PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Payslip', MARGIN, 18);
  doc.setFontSize(10);
  doc.text(run.employer.name, pageW - MARGIN, 18, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const employerAddress = cleanAddress(run.employer.address);
  const hasAddress = employerAddress !== '';
  const address: string[] = hasAddress ? doc.splitTextToSize(employerAddress, 80) : ['Employer address not recorded'];
  if (!hasAddress && run.final) { // BCEA s33(1)(a): a final slip must say plainly that a particular is missing
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.DANGER);
  }
  doc.text(address, pageW - MARGIN, 23, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...COLORS.TEXT_PRIMARY);
  let y = 24 + address.length * 3.6;
  const periodLabel = `${MONTHS[run.periodMonth - 1]} ${run.periodYear}: ${payPeriodLabel(run.periodMonth, run.periodYear)}`;
  const facts = particulars(run, slip, periodLabel);
  y = Math.max(y, 30);
  for (const [label, value] of facts) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, MARGIN, y);
    doc.setFont('helvetica', 'normal');
    doc.text(value, MARGIN + 34, y);
    y += 4.6;
  }
  return y + 2;
}

const NOTE_LINE = 3.6;

/** Where the "Not itemised" note goes: below the last table, or at the top of a new page if it would run off the bottom. */
export function notePlacement(y: number, lineCount: number, pageH: number): { newPage: boolean; y: number } {
  const fits = y + 2 + lineCount * NOTE_LINE <= pageH - MARGIN;
  return fits ? { newPage: false, y: y + 2 } : { newPage: true, y: TOP + 2 };
}

function slipPage(doc: JsPdfDoc, autoTable: AutoTable, run: PayslipRun, slip: Payslip): void {
  const pageW: number = doc.internal.pageSize.getWidth();
  const pageH: number = doc.internal.pageSize.getHeight();
  let y = heading(doc, run, slip, pageW);
  y = table(doc, autoTable, y, 'Earnings', slip.earnings.map(itemRow), ['Gross pay', slip.grossPay]);
  const deductions = [
    ['PAYE (income tax)', money(slip.paye)],
    ['UIF (employee)', money(slip.uifEmployee)],
    ...slip.deductions.map(itemRow),
  ];
  y = table(doc, autoTable, y, 'Deductions', deductions, ['Total deductions', round2(slip.paye + slip.uifEmployee + slip.otherDeductions)]);
  y = table(doc, autoTable, y, 'Amount paid', [['Net pay', money(slip.netPay)]]);
  if (slip.benefits.length > 0) {
    y = table(doc, autoTable, y, BENEFIT_NOTE, slip.benefits.map(itemRow));
  }
  if (slip.paidDirectly.length > 0) {
    y = table(doc, autoTable, y, PAID_DIRECTLY_NOTE, slip.paidDirectly.map(itemRow));
  }
  if (slip.retirementFund) {
    const r = slip.retirementFund;
    y = table(doc, autoTable, y, 'Retirement fund contributions (counted for your tax)', [
      ['Your own contributions', money(r.own)], ['Employer contribution, counted as yours', money(r.employerDeemed)],
    ], ['Contributions (before the s11F limit)', round2(r.own + r.employerDeemed)]);
  }
  y = table(doc, autoTable, y, 'Employer contributions (not deducted from your pay)', [
    ['UIF (employer)', money(slip.uifEmployer)], ['Skills development levy', money(slip.sdl)],
    ...slip.employerContributions.map(itemRow),
  ]);
  const ytd = slip.yearToDate;
  y = table(doc, autoTable, y, 'Year to date (this tax year)', [
    ['Gross pay', money(ytd.grossPay)], ['PAYE', money(ytd.paye)], ['UIF (employee)', money(ytd.uifEmployee)], ['Net pay', money(ytd.netPay)],
  ]);
  const note = notItemisedNote(slip);
  if (note) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.TEXT_SECONDARY);
    const lines: string[] = doc.splitTextToSize(note, pageW - MARGIN * 2);
    const at = notePlacement(y, lines.length, pageH);
    if (at.newPage) doc.addPage();
    doc.text(lines, MARGIN, at.y);
  }
}

export async function buildPayslipPdf(run: PayslipRun): Promise<Buffer> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc: JsPdfDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  run.payslips.forEach((slip, index) => {
    if (index > 0) doc.addPage();
    slipPage(doc, autoTable as unknown as AutoTable, run, slip);
  });
  if (!run.final) draftEveryPage(doc);
  return Buffer.from(doc.output('arraybuffer'));
}

/** A filename that can only hold safe characters, whatever an employee number holds. */
export function payslipFilename(run: PayslipRun, employeeNumber?: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '');
  const period = `${run.periodYear}-${pad(run.periodMonth)}`;
  return employeeNumber ? `payslip-${period}-${safe(employeeNumber) || 'employee'}.pdf` : `payslips-${period}.pdf`;
}
