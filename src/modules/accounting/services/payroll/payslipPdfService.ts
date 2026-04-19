/**
 * Payslip PDF generation service.
 * Generates an A4 payslip PDF for a single employee within a payroll run.
 */
import PDFDocument from 'pdfkit';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface ComponentBreakdownItem {
  componentId: string;
  componentName: string;
  sarsSourceCode: string;
  amount: number;
  isTaxable: boolean;
  isUifApplicable: boolean;
}

interface PayslipData {
  companyName: string;
  periodMonth: number;
  periodYear: number;
  runStatus: string;
  employeeName: string;
  employeeNumber: string;
  idNumber: string | null;
  taxNumber: string | null;
  grossPay: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  netPay: number;
  breakdown: ComponentBreakdownItem[];
}

async function loadPayslipData(
  companyId: string,
  runId: string,
  employeeId: string,
): Promise<PayslipData> {
  const runRows = (await sql`
    SELECT prh.period_month, prh.period_year, prh.status,
           c.name AS company_name
    FROM payroll_run_headers prh
    JOIN companies c ON c.id = prh.company_id
    WHERE prh.id = ${runId}::uuid AND prh.company_id = ${companyId}::uuid
  `) as Row[];

  if (runRows.length === 0 || !runRows[0]) {
    throw new Error(`Payroll run ${runId} not found`);
  }
  const run = runRows[0];

  const lineRows = (await sql`
    SELECT prl.gross_pay, prl.paye, prl.uif_employee, prl.uif_employer,
           prl.sdl, prl.net_pay, prl.component_breakdown
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    WHERE prl.run_id = ${runId}::uuid
      AND prl.employee_id = ${employeeId}::uuid
      AND prh.company_id = ${companyId}::uuid
  `) as Row[];

  if (lineRows.length === 0 || !lineRows[0]) {
    throw new Error(`No payroll line for employee ${employeeId} in run ${runId}`);
  }
  const line = lineRows[0];

  const empRows = (await sql`
    SELECT first_name, last_name, employee_number, id_number, tax_number
    FROM payroll_employees
    WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];

  if (empRows.length === 0 || !empRows[0]) {
    throw new Error(`Employee ${employeeId} not found`);
  }
  const emp = empRows[0];

  let breakdown: ComponentBreakdownItem[] = [];
  const rawBreakdown = line.component_breakdown;
  if (Array.isArray(rawBreakdown)) {
    breakdown = rawBreakdown as ComponentBreakdownItem[];
  } else if (typeof rawBreakdown === 'string') {
    try {
      breakdown = JSON.parse(rawBreakdown) as ComponentBreakdownItem[];
    } catch {
      breakdown = [];
    }
  }

  return {
    companyName: String(run.company_name),
    periodMonth: Number(run.period_month),
    periodYear: Number(run.period_year),
    runStatus: String(run.status),
    employeeName: `${String(emp.first_name)} ${String(emp.last_name)}`,
    employeeNumber: String(emp.employee_number),
    idNumber: emp.id_number ? String(emp.id_number) : null,
    taxNumber: emp.tax_number ? String(emp.tax_number) : null,
    grossPay: Number(line.gross_pay),
    paye: Number(line.paye),
    uifEmployee: Number(line.uif_employee),
    uifEmployer: Number(line.uif_employer),
    sdl: Number(line.sdl),
    netPay: Number(line.net_pay),
    breakdown,
  };
}

function fmt(n: number): string {
  return `R ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

function renderPdf(data: PayslipData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(18).text(data.companyName, { align: 'left' });
      doc.fontSize(10).fillColor('#666').text('Payslip', { align: 'left' });
      doc.moveDown(0.5);
      doc
        .fillColor('#000')
        .fontSize(12)
        .text(`Period: ${MONTHS[data.periodMonth - 1] ?? ''} ${data.periodYear}`, {
          align: 'left',
        });
      doc.moveDown(1);

      // Employee panel
      doc.fontSize(11).fillColor('#000');
      doc.text(`Employee: ${data.employeeName}`);
      doc.text(`Employee number: ${data.employeeNumber}`);
      if (data.idNumber) doc.text(`ID number: ${data.idNumber}`);
      if (data.taxNumber) doc.text(`Tax number: ${data.taxNumber}`);
      doc.moveDown(1);

      // Earnings
      const earnings = data.breakdown.filter((b) => b.amount > 0);
      if (earnings.length > 0) {
        doc.fontSize(12).fillColor('#0a7d7d').text('Earnings');
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor('#000');
        for (const e of earnings) {
          doc.text(`${e.componentName}  (SARS ${e.sarsSourceCode})`, { continued: true });
          doc.text(fmt(e.amount), { align: 'right' });
        }
        doc.moveDown(0.5);
        doc.fontSize(11).text('Gross pay', { continued: true });
        doc.text(fmt(data.grossPay), { align: 'right' });
        doc.moveDown(1);
      }

      // Deductions
      doc.fontSize(12).fillColor('#0a7d7d').text('Deductions');
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#000');
      doc.text('PAYE', { continued: true });
      doc.text(fmt(data.paye), { align: 'right' });
      doc.text('UIF (employee)', { continued: true });
      doc.text(fmt(data.uifEmployee), { align: 'right' });
      doc.moveDown(1);

      // Net pay footer
      doc.fontSize(14).fillColor('#0a7d7d').text('Net pay', { continued: true });
      doc.fillColor('#000').text(fmt(data.netPay), { align: 'right' });

      doc.moveDown(2);
      doc.fontSize(8).fillColor('#999').text(`Run status: ${data.runStatus}`, { align: 'left' });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export async function generatePayslipPdf(
  companyId: string,
  runId: string,
  employeeId: string,
): Promise<Buffer> {
  log.info('Generating payslip PDF', { companyId, runId, employeeId }, 'payslipPdfService');
  const data = await loadPayslipData(companyId, runId, employeeId);
  return renderPdf(data);
}
