/**
 * Payroll Documents API
 * GET /api/payroll/payroll-documents?runId=xxx&type=pay-register|emp201|leave-report|remuneration|batch-payslips
 * Generates professional payroll PDFs matching Sage/VIP standard output.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const fmtR = (n: number) => n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: string | Date) => { const dt = new Date(d); return dt.toLocaleDateString('en-ZA', { year: 'numeric', month: '2-digit', day: '2-digit' }); };
const fmtPeriod = (d: string | Date) => { const dt = new Date(d); return `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`; };

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { runId, type } = req.query;
  if (!runId || !type) return apiResponse.badRequest(res, 'runId and type are required');

  const validTypes = ['pay-register', 'emp201', 'leave-report', 'remuneration', 'batch-payslips'];
  if (!validTypes.includes(type as string)) return apiResponse.badRequest(res, `type must be one of: ${validTypes.join(', ')}`);

  try {
    // Get company info
    const companies = await sql`SELECT name, registration_number, vat_number FROM companies WHERE id = ${companyId}` as Row[];
    const company = companies[0] || { name: 'Unknown Company', registration_number: '', vat_number: '' };

    // Get payroll run
    const runs = await sql`SELECT * FROM payroll_runs WHERE id = ${runId as string}::UUID AND company_id = ${companyId}` as Row[];
    if (!runs[0]) return apiResponse.notFound(res, 'Payroll Run', runId as string);
    const run = runs[0];

    // Get payslips with employee data
    const payslips = await sql`
      SELECT ps.*, e.employee_number, e.first_name, e.last_name,
        e.id_number, e.tax_number, e.department, e.position,
        e.bank_name, e.bank_account_number, e.bank_branch_code
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      WHERE ps.payroll_run_id = ${runId as string}::UUID
      ORDER BY e.employee_number
    ` as Row[];

    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF();
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 15; // margin

    const periodEnd = fmtPeriod(run.period_end);
    const periodLabel = `FOR PERIOD ENDING ${periodEnd}`;
    const docType = type as string;

    // ── Shared header helper ────────────────────────────────────────────
    const drawHeader = (title: string, pageNum?: number) => {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(`ISAFLOW PAYROLL SYSTEM`, m, 10);
      doc.text(`PRINTED ON ${fmtDate(new Date())}`, m, 14);
      doc.text(String(company.name), pw / 2, 10, { align: 'center' });
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(title, pw / 2, 20, { align: 'center' });
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(periodLabel, pw / 2, 25, { align: 'center' });
      if (company.registration_number) doc.text(`Co. Reg: ${company.registration_number}`, pw - m, 10, { align: 'right' });
      if (pageNum) doc.text(`PAGE ${pageNum}`, pw - m, 14, { align: 'right' });
      doc.setDrawColor(0, 128, 128);
      doc.setLineWidth(0.3);
      doc.line(m, 28, pw - m, 28);
    };

    // ═══════════════════════════════════════════════════════════════════
    if (docType === 'pay-register') {
      drawHeader('PAYROLL REGISTER - CURRENT PERIOD');
      let y = 35;

      for (const slip of payslips) {
        if (y > ph - 50) { doc.addPage(); drawHeader('PAYROLL REGISTER - CURRENT PERIOD'); y = 35; }

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

        // Earnings
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
        doc.text('GROSS:', m, y); doc.text(fmtR(Number(slip.gross_pay)), m + 55, y, { align: 'right' });
        const totalDed = Number(slip.paye) + Number(slip.uif_employee) + Number(slip.medical_aid) + Number(slip.retirement_fund) + Number(slip.other_deductions);
        doc.text('TOTAL DED:', m + 80, y); doc.text(fmtR(totalDed), m + 135, y, { align: 'right' });
        doc.text(`NET PAY: R ${fmtR(Number(slip.net_pay))}`, m + 150, y);
        y += 3;
        doc.setDrawColor(180, 180, 180);
        doc.line(m, y, pw - m, y);
        y += 7;
      }

      // Totals
      if (y > ph - 30) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      y += 5;
      doc.text('COMPANY TOTALS', m, y); y += 6;
      doc.setFontSize(9);
      doc.text(`Total Gross Pay:`, m, y); doc.text(`R ${fmtR(Number(run.total_gross))}`, m + 55, y); y += 5;
      doc.text(`Total PAYE:`, m, y); doc.text(`R ${fmtR(Number(run.total_paye))}`, m + 55, y); y += 5;
      doc.text(`Total UIF (Employee):`, m, y); doc.text(`R ${fmtR(Number(run.total_uif_employee))}`, m + 55, y); y += 5;
      doc.text(`Total UIF (Employer):`, m, y); doc.text(`R ${fmtR(Number(run.total_uif_employer))}`, m + 55, y); y += 5;
      doc.text(`Total SDL:`, m, y); doc.text(`R ${fmtR(Number(run.total_sdl))}`, m + 55, y); y += 5;
      doc.text(`Total Net Pay:`, m, y); doc.text(`R ${fmtR(Number(run.total_net))}`, m + 55, y); y += 5;
      doc.text(`Total Company Cost:`, m, y); doc.text(`R ${fmtR(Number(run.total_gross) + Number(run.total_uif_employer) + Number(run.total_sdl))}`, m + 55, y);

    // ═══════════════════════════════════════════════════════════════════
    } else if (docType === 'emp201') {
      drawHeader('EMP201 PAYE, SDL AND UIF RETURN');
      let y = 35;

      // Column headers
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
        if (y > ph - 25) { doc.addPage(); drawHeader('EMP201 PAYE, SDL AND UIF RETURN'); y = 35; }
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

    // ═══════════════════════════════════════════════════════════════════
    } else if (docType === 'leave-report') {
      drawHeader('LEAVE REPORT');
      let y = 35;

      // Get leave balances
      const leaveData = await sql`
        SELECT lb.*, e.employee_number, e.first_name, e.last_name, e.department,
               lt.name as leave_type_name
        FROM leave_balances lb
        JOIN employees e ON e.id = lb.employee_id
        JOIN leave_types lt ON lt.code = lb.leave_type_code
        WHERE e.company_id = ${companyId}
        ORDER BY e.employee_number, lb.leave_type_code
      ` as Row[];

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
        if (y > ph - 20) { doc.addPage(); drawHeader('LEAVE REPORT'); y = 35; }
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

    // ═══════════════════════════════════════════════════════════════════
    } else if (docType === 'remuneration') {
      drawHeader('REMUNERATION LIST (BANK PAYMENT INSTRUCTIONS)');
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
        if (y > ph - 25) { doc.addPage(); drawHeader('REMUNERATION LIST'); y = 35; }
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

    // ═══════════════════════════════════════════════════════════════════
    } else if (docType === 'batch-payslips') {
      // Generate all payslips in one PDF
      for (let idx = 0; idx < payslips.length; idx++) {
        if (idx > 0) doc.addPage();
        const slip = payslips[idx]!;
        let y = 15;

        // Company header
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

        // Employee info
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

        // Earnings
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

        // Deductions
        doc.text('DEDUCTIONS', pw / 2 + 10, y - (earns.filter(e => e[1] > 0).length * 4 + 13));
        let dy = y - (earns.filter(e => e[1] > 0).length * 4 + 8);
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

        // Net Pay box
        y = Math.max(y, dy) + 10;
        doc.setFillColor(240, 253, 250);
        doc.rect(m, y - 3, pw - 2 * m, 14, 'F');
        doc.setDrawColor(0, 128, 128);
        doc.rect(m, y - 3, pw - 2 * m, 14, 'S');
        doc.setFontSize(12);
        doc.text('NET PAY', m + 5, y + 6);
        doc.text(`R ${fmtR(Number(slip.net_pay))}`, pw - m - 5, y + 6, { align: 'right' });
        y += 18;

        // Employer costs
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.text(`Employer: UIF R ${fmtR(Number(slip.uif_employer))} | SDL R ${fmtR(Number(slip.sdl))}`, m, y);
        y += 5;
        doc.text(`YTD: Gross R ${fmtR(Number(slip.ytd_gross))} | PAYE R ${fmtR(Number(slip.ytd_paye))}`, m, y);

        // Banking
        if (slip.bank_name) {
          y += 8;
          doc.setFont('helvetica', 'bold');
          doc.text('Banking:', m, y);
          doc.setFont('helvetica', 'normal');
          doc.text(`${slip.bank_name} | Acc: ${slip.bank_account_number || '-'} | Branch: ${slip.bank_branch_code || '-'}`, m + 20, y);
        }
      }
    }

    // Output
    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    const cleanPeriod = fmtPeriod(run.period_end).replace(/\//g, '-');
    const filename = `${String(company.name).replace(/[^a-zA-Z0-9]/g, '')}-${docType}-${cleanPeriod}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.status(200).end(pdfBuffer);

    log.info('Payroll document generated', { type: docType, runId, employees: payslips.length }, 'payroll');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('Payroll document generation failed', { runId, type, error: errMsg }, 'payroll');
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: `Failed to generate payroll document: ${errMsg}` } });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
