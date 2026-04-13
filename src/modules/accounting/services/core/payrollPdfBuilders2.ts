/**
 * Payroll PDF Builders — Part 2
 * Builds: Remuneration List, Batch Payslips
 * Used by payrollPdfService.ts
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const fmtR = (n: number) =>
  n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

import { fmtDate, fmtPeriod, drawHeader, type PdfCompany } from './payrollPdfBuilders1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsPdfDoc = any;

export function buildRemuneration(
  doc: JsPdfDoc,
  company: PdfCompany,
  run: Row,
  payslips: Row[],
) {
  const m = 15;
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const periodLabel = `FOR PERIOD ENDING ${fmtPeriod(run.period_end)}`;
  const title = 'REMUNERATION LIST (BANK PAYMENT INSTRUCTIONS)';

  drawHeader(doc, title, pw, company, periodLabel);
  let y = 35;

  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.text('EMP CODE', m, y);
  doc.text('EMPLOYEE NAME', m + 25, y);
  doc.text('NET PAY', m + 85, y, { align: 'right' });
  doc.text('BANK', m + 100, y);
  doc.text('ACCOUNT NO', m + 135, y);
  doc.text('BRANCH', m + 170, y);
  y += 2; doc.line(m, y, pw - m, y); y += 5;

  doc.setFont('helvetica', 'normal');
  let totalNet = 0;
  for (const slip of payslips) {
    if (y > ph - 25) { doc.addPage(); drawHeader(doc, 'REMUNERATION LIST', pw, company, periodLabel); y = 35; }
    totalNet += Number(slip.net_pay);
    doc.text(slip.employee_number, m, y);
    doc.text(`${slip.first_name} ${slip.last_name}`, m + 25, y);
    doc.text(fmtR(Number(slip.net_pay)), m + 85, y, { align: 'right' });
    doc.text(slip.bank_name || '-', m + 100, y);
    doc.text(slip.bank_account_number || '-', m + 135, y);
    doc.text(slip.bank_branch_code || '-', m + 170, y);
    y += 4;
  }

  y += 3;
  doc.setFont('helvetica', 'bold');
  doc.line(m, y - 2, pw - m, y - 2);
  doc.text('TOTAL PAYMENT', m, y);
  doc.text(`R ${fmtR(totalNet)}`, m + 85, y, { align: 'right' });
  doc.text(`${payslips.length} employees`, m + 100, y);
}

export function buildBatchPayslips(
  doc: JsPdfDoc,
  company: PdfCompany,
  run: Row,
  payslips: Row[],
) {
  const m = 15;
  const pw = doc.internal.pageSize.getWidth();

  for (let idx = 0; idx < payslips.length; idx++) {
    if (idx > 0) doc.addPage();
    const slip = payslips[idx]!;
    let y = 15;

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text(String(company.name), pw / 2, y, { align: 'center' });
    y += 7;
    doc.setFontSize(10);
    doc.text('PAYSLIP', pw / 2, y, { align: 'center' });
    y += 5;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(`Pay Period: ${fmtDate(run.period_start)} - ${fmtDate(run.period_end)}`, pw / 2, y, { align: 'center' });
    y += 3;
    doc.text(`Payment Date: ${fmtDate(run.run_date)}`, pw / 2, y, { align: 'center' });
    y += 8;

    doc.setDrawColor(0, 128, 128);
    doc.line(m, y, pw - m, y);
    y += 7;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const info: [string, string][] = [
      ['Employee #', slip.employee_number],
      ['Name', `${slip.first_name} ${slip.last_name}`],
      ['ID Number', slip.id_number || '-'],
      ['Tax Number', slip.tax_number || '-'],
      ['Department', slip.department || '-'],
      ['Position', slip.position || '-'],
    ];
    for (const [label, val] of info) {
      doc.setFont('helvetica', 'bold');
      doc.text(`${label}:`, m, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(val), m + 35, y);
      y += 4.5;
    }
    y += 3;
    doc.line(m, y, pw - m, y);
    y += 7;

    doc.setFont('helvetica', 'bold');
    doc.text('EARNINGS', m, y);
    doc.text('R', pw / 2 - 5, y, { align: 'right' });
    y += 5;
    doc.setFont('helvetica', 'normal');
    const earns: [string, number][] = [
      ['Basic Salary', Number(slip.basic_salary)],
      ['Travel Allowance', Number(slip.travel_allowance)],
      ['Housing Allowance', Number(slip.housing_allowance)],
      ['Cell Allowance', Number(slip.cell_allowance)],
      ['Other Allowances', Number(slip.other_allowances)],
    ];
    for (const [l, a] of earns) {
      if (a > 0) { doc.text(l, m + 5, y); doc.text(fmtR(a), pw / 2 - 5, y, { align: 'right' }); y += 4; }
    }
    y += 1;
    doc.setFont('helvetica', 'bold');
    doc.text('Gross Pay', m + 5, y);
    doc.text(fmtR(Number(slip.gross_pay)), pw / 2 - 5, y, { align: 'right' });
    y += 7;

    const filtEarns = earns.filter(e => e[1] > 0);
    doc.text('DEDUCTIONS', pw / 2 + 10, y - (filtEarns.length * 4 + 13));
    let dy = y - (filtEarns.length * 4 + 8);
    doc.setFont('helvetica', 'normal');
    const deds: [string, number][] = [
      ['PAYE', Number(slip.paye)],
      ['UIF', Number(slip.uif_employee)],
      ['Medical Aid', Number(slip.medical_aid)],
      ['Retirement Fund', Number(slip.retirement_fund)],
      ['Other', Number(slip.other_deductions)],
    ];
    for (const [l, a] of deds) {
      if (a > 0) { doc.text(l, pw / 2 + 15, dy); doc.text(fmtR(a), pw - m, dy, { align: 'right' }); dy += 4; }
    }
    const totalDed = deds.reduce((s, d) => s + d[1], 0);
    dy += 1;
    doc.setFont('helvetica', 'bold');
    doc.text('Total Deductions', pw / 2 + 15, dy);
    doc.text(fmtR(totalDed), pw - m, dy, { align: 'right' });

    y = Math.max(y, dy) + 10;
    doc.setFillColor(240, 253, 250);
    doc.rect(m, y - 3, pw - 2 * m, 14, 'F');
    doc.setDrawColor(0, 128, 128);
    doc.rect(m, y - 3, pw - 2 * m, 14, 'S');
    doc.setFontSize(12);
    doc.text('NET PAY', m + 5, y + 6);
    doc.text(`R ${fmtR(Number(slip.net_pay))}`, pw - m - 5, y + 6, { align: 'right' });
    y += 18;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(`Employer: UIF R ${fmtR(Number(slip.uif_employer))} | SDL R ${fmtR(Number(slip.sdl))}`, m, y);
    y += 5;
    doc.text(`YTD: Gross R ${fmtR(Number(slip.ytd_gross))} | PAYE R ${fmtR(Number(slip.ytd_paye))}`, m, y);

    if (slip.bank_name) {
      y += 8;
      doc.setFont('helvetica', 'bold');
      doc.text('Banking:', m, y);
      doc.setFont('helvetica', 'normal');
      doc.text(
        `${slip.bank_name} | Acc: ${slip.bank_account_number || '-'} | Branch: ${slip.bank_branch_code || '-'}`,
        m + 20, y,
      );
    }
  }
}
