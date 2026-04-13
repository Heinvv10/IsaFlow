/**
 * Payroll PDF Builders — Part 1
 * Builds: Pay Register, EMP201, Leave Report
 * Used by payrollPdfService.ts
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const fmtR = (n: number) =>
  n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (d: string | Date) => {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-ZA', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

export const fmtPeriod = (d: string | Date) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
};

export interface PdfCompany {
  name: string;
  registration_number?: string;
  vat_number?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsPdfDoc = any;

export function drawHeader(
  doc: JsPdfDoc,
  title: string,
  pw: number,
  company: PdfCompany,
  periodLabel: string,
  pageNum?: number,
) {
  const m = 15;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text('ISAFLOW PAYROLL SYSTEM', m, 10);
  doc.text(`PRINTED ON ${fmtDate(new Date())}`, m, 14);
  doc.text(String(company.name), pw / 2, 10, { align: 'center' });
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(title, pw / 2, 20, { align: 'center' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(periodLabel, pw / 2, 25, { align: 'center' });
  if (company.registration_number) {
    doc.text(`Co. Reg: ${company.registration_number}`, pw - m, 10, { align: 'right' });
  }
  if (pageNum) doc.text(`PAGE ${pageNum}`, pw - m, 14, { align: 'right' });
  doc.setDrawColor(0, 128, 128);
  doc.setLineWidth(0.3);
  doc.line(m, 28, pw - m, 28);
}

export function buildPayRegister(
  doc: JsPdfDoc,
  company: PdfCompany,
  run: Row,
  payslips: Row[],
) {
  const m = 15;
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const periodLabel = `FOR PERIOD ENDING ${fmtPeriod(run.period_end)}`;
  const title = 'PAYROLL REGISTER - CURRENT PERIOD';

  drawHeader(doc, title, pw, company, periodLabel);
  let y = 35;

  for (const slip of payslips) {
    if (y > ph - 50) { doc.addPage(); drawHeader(doc, title, pw, company, periodLabel); y = 35; }
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(`EMPL.CODE: ${slip.employee_number}`, m, y);
    doc.text(`EMP NAME: ${slip.first_name} ${slip.last_name}`, m + 60, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.text(`Department: ${slip.department || '-'}`, m, y);
    doc.text(`ID NUMBER: ${slip.id_number || '-'}`, m + 60, y);
    doc.text(`Position: ${slip.position || '-'}`, m + 130, y);
    y += 7;

    doc.setFont('helvetica', 'bold');
    doc.text('EARNINGS', m, y);
    doc.text('DEDUCTIONS', m + 80, y);
    y += 5;
    doc.setFont('helvetica', 'normal');

    const earnings: [string, number][] = [
      ['Basic Salary', Number(slip.basic_salary)],
      ['Travel Allowance', Number(slip.travel_allowance)],
      ['Housing Allowance', Number(slip.housing_allowance)],
      ['Cell Allowance', Number(slip.cell_allowance)],
      ['Other Allowances', Number(slip.other_allowances)],
    ];
    const deductions: [string, number][] = [
      ['PAYE', Number(slip.paye)],
      ['UIF', Number(slip.uif_employee)],
      ['Medical Aid', Number(slip.medical_aid)],
      ['Retirement', Number(slip.retirement_fund)],
      ['Other', Number(slip.other_deductions)],
    ];

    const filtE = earnings.filter(e => e[1] > 0);
    const filtD = deductions.filter(d => d[1] > 0);
    const maxRows = Math.max(filtE.length, filtD.length);
    for (let i = 0; i < maxRows; i++) {
      const e = filtE[i]; const d = filtD[i];
      if (e) { doc.text(e[0], m, y); doc.text(fmtR(e[1]), m + 55, y, { align: 'right' }); }
      if (d) { doc.text(d[0], m + 80, y); doc.text(fmtR(d[1]), m + 135, y, { align: 'right' }); }
      y += 4;
    }

    y += 2;
    doc.setFont('helvetica', 'bold');
    doc.text('GROSS:', m, y);
    doc.text(fmtR(Number(slip.gross_pay)), m + 55, y, { align: 'right' });
    const totalDed = Number(slip.paye) + Number(slip.uif_employee) + Number(slip.medical_aid)
      + Number(slip.retirement_fund) + Number(slip.other_deductions);
    doc.text('TOTAL DED:', m + 80, y);
    doc.text(fmtR(totalDed), m + 135, y, { align: 'right' });
    doc.text(`NET PAY: R ${fmtR(Number(slip.net_pay))}`, m + 150, y);
    y += 3;
    doc.setDrawColor(180, 180, 180);
    doc.line(m, y, pw - m, y);
    y += 7;
  }

  if (y > ph - 30) { doc.addPage(); y = 20; }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  y += 5;
  doc.text('COMPANY TOTALS', m, y); y += 6;
  doc.setFontSize(9);
  doc.text('Total Gross Pay:', m, y); doc.text(`R ${fmtR(Number(run.total_gross))}`, m + 55, y); y += 5;
  doc.text('Total PAYE:', m, y); doc.text(`R ${fmtR(Number(run.total_paye))}`, m + 55, y); y += 5;
  doc.text('Total UIF (Employee):', m, y); doc.text(`R ${fmtR(Number(run.total_uif_employee))}`, m + 55, y); y += 5;
  doc.text('Total UIF (Employer):', m, y); doc.text(`R ${fmtR(Number(run.total_uif_employer))}`, m + 55, y); y += 5;
  doc.text('Total SDL:', m, y); doc.text(`R ${fmtR(Number(run.total_sdl))}`, m + 55, y); y += 5;
  doc.text('Total Net Pay:', m, y); doc.text(`R ${fmtR(Number(run.total_net))}`, m + 55, y); y += 5;
  doc.text('Total Company Cost:', m, y);
  doc.text(
    `R ${fmtR(Number(run.total_gross) + Number(run.total_uif_employer) + Number(run.total_sdl))}`,
    m + 55, y,
  );
}

export function buildEmp201(
  doc: JsPdfDoc,
  company: PdfCompany,
  run: Row,
  payslips: Row[],
) {
  const m = 15;
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const periodLabel = `FOR PERIOD ENDING ${fmtPeriod(run.period_end)}`;
  const title = 'EMP201 PAYE, SDL AND UIF RETURN';

  drawHeader(doc, title, pw, company, periodLabel);
  let y = 35;

  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.text('EMP CODE', m, y);
  doc.text('EMP NAME', m + 25, y);
  doc.text('PAYE REM', m + 75, y, { align: 'right' });
  doc.text('PAYE AMT', m + 95, y, { align: 'right' });
  doc.text('SDL REM', m + 115, y, { align: 'right' });
  doc.text('SDL AMT', m + 135, y, { align: 'right' });
  doc.text('UIF REM', m + 155, y, { align: 'right' });
  doc.text('UIF AMT', m + 175, y, { align: 'right' });
  y += 2;
  doc.line(m, y, pw - m, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  let totPaye = 0, totSdl = 0, totUif = 0, totGross = 0;

  for (const slip of payslips) {
    if (y > ph - 25) { doc.addPage(); drawHeader(doc, title, pw, company, periodLabel); y = 35; }
    const gross = Number(slip.gross_pay);
    const paye = Number(slip.paye);
    const sdl = Number(slip.sdl);
    const uif = Number(slip.uif_employee) + Number(slip.uif_employer);
    totGross += gross; totPaye += paye; totSdl += sdl; totUif += uif;

    doc.text(slip.employee_number, m, y);
    doc.text(`${slip.last_name} ${(slip.first_name || '')[0] || ''}`, m + 25, y);
    doc.text(fmtR(gross), m + 75, y, { align: 'right' });
    doc.text(fmtR(paye), m + 95, y, { align: 'right' });
    doc.text(fmtR(gross), m + 115, y, { align: 'right' });
    doc.text(fmtR(sdl), m + 135, y, { align: 'right' });
    doc.text(fmtR(gross), m + 155, y, { align: 'right' });
    doc.text(fmtR(uif), m + 175, y, { align: 'right' });
    y += 4;
  }

  y += 3;
  doc.setFont('helvetica', 'bold');
  doc.line(m, y - 2, pw - m, y - 2);
  doc.text('TOTALS', m, y);
  doc.text(fmtR(totGross), m + 75, y, { align: 'right' });
  doc.text(fmtR(totPaye), m + 95, y, { align: 'right' });
  doc.text(fmtR(totGross), m + 115, y, { align: 'right' });
  doc.text(fmtR(totSdl), m + 135, y, { align: 'right' });
  doc.text(fmtR(totGross), m + 155, y, { align: 'right' });
  doc.text(fmtR(totUif), m + 175, y, { align: 'right' });
}

export function buildLeaveReport(
  doc: JsPdfDoc,
  company: PdfCompany,
  run: Row,
  leaveData: Row[],
) {
  const m = 15;
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const periodLabel = `FOR PERIOD ENDING ${fmtPeriod(run.period_end)}`;
  const title = 'LEAVE REPORT';

  drawHeader(doc, title, pw, company, periodLabel);
  let y = 35;

  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.text('EMP CODE', m, y);
  doc.text('EMPLOYEE NAME', m + 25, y);
  doc.text('DEPT', m + 70, y);
  doc.text('LEAVE TYPE', m + 95, y);
  doc.text('ENTITLED', m + 135, y, { align: 'right' });
  doc.text('TAKEN', m + 155, y, { align: 'right' });
  doc.text('BALANCE', m + 175, y, { align: 'right' });
  y += 2; doc.line(m, y, pw - m, y); y += 5;

  doc.setFont('helvetica', 'normal');
  for (const lb of leaveData) {
    if (y > ph - 20) { doc.addPage(); drawHeader(doc, title, pw, company, periodLabel); y = 35; }
    doc.text(lb.employee_number, m, y);
    doc.text(`${lb.first_name} ${lb.last_name}`, m + 25, y);
    doc.text(lb.department || '-', m + 70, y);
    doc.text(lb.leave_type_name, m + 95, y);
    doc.text(String(Number(lb.opening_balance || 0) + Number(lb.accrued || 0)), m + 135, y, { align: 'right' });
    doc.text(String(Number(lb.taken || 0)), m + 155, y, { align: 'right' });
    doc.text(String(Number(lb.closing_balance || 0)), m + 175, y, { align: 'right' });
    y += 4;
  }

  if (leaveData.length === 0) {
    doc.text('No leave balances found for this period.', m, y);
  }
}
