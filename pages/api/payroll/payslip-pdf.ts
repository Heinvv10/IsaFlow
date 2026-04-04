/**
 * Payslip PDF API
 * GET /api/payroll/payslip-pdf?id=xxx  - Generate PDF payslip
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { formatDisplayDate } from '@/utils/dateFormat';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Payslip ID is required');
  }

  try {
    // Get payslip with employee and run data (scoped to company)
    const rows = (await sql`
      SELECT ps.*, e.employee_number, e.first_name, e.last_name,
        e.id_number, e.tax_number, e.department, e.position,
        e.bank_name, e.bank_account_number, e.bank_branch_code,
        pr.period_start, pr.period_end
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      WHERE ps.id = ${id}
        AND e.company_id = ${companyId}::UUID
    `) as Row[];

    if (rows.length === 0 || !rows[0]) {
      return apiResponse.notFound(res, 'Payslip', id);
    }

    const slip = rows[0] as Row;

    // Generate PDF using jsPDF
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF();

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    let y = 20;

    // Company header
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('PAYSLIP', pageWidth / 2, y, { align: 'center' });
    y += 10;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(
      `Pay Period: ${formatDisplayDate(slip.period_start)} - ${formatDisplayDate(slip.period_end)}`,
      pageWidth / 2, y, { align: 'center' }
    );
    y += 15;

    // Divider
    doc.setDrawColor(0, 128, 128);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 10;

    // Employee details
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Employee Details', margin, y);
    y += 7;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const empDetails = [
      ['Employee Number', String(slip.employee_number)],
      ['Name', `${slip.first_name} ${slip.last_name}`],
      ['ID Number', slip.id_number || '-'],
      ['Tax Number', slip.tax_number || '-'],
      ['Department', slip.department || '-'],
      ['Position', slip.position || '-'],
    ];

    for (const [label, value] of empDetails) {
      doc.setFont('helvetica', 'bold');
      doc.text(`${label}:`, margin, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(value), margin + 45, y);
      y += 5;
    }
    y += 5;

    // Divider
    doc.line(margin, y, pageWidth - margin, y);
    y += 10;

    // Earnings
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Earnings', margin, y);
    doc.text('Amount (R)', pageWidth - margin, y, { align: 'right' });
    y += 7;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const earnings = [
      ['Basic Salary', Number(slip.basic_salary)],
      ['Travel Allowance', Number(slip.travel_allowance)],
      ['Housing Allowance', Number(slip.housing_allowance)],
      ['Cell Allowance', Number(slip.cell_allowance)],
      ['Other Allowances', Number(slip.other_allowances)],
    ];

    for (const [label, amount] of earnings) {
      if (Number(amount) > 0) {
        doc.text(String(label), margin, y);
        doc.text(formatAmountRaw(Number(amount)), pageWidth - margin, y, { align: 'right' });
        y += 5;
      }
    }

    y += 2;
    doc.setFont('helvetica', 'bold');
    doc.text('Gross Pay', margin, y);
    doc.text(formatAmountRaw(Number(slip.gross_pay)), pageWidth - margin, y, { align: 'right' });
    y += 8;

    // Divider
    doc.line(margin, y, pageWidth - margin, y);
    y += 10;

    // Deductions
    doc.setFontSize(11);
    doc.text('Deductions', margin, y);
    doc.text('Amount (R)', pageWidth - margin, y, { align: 'right' });
    y += 7;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const deductions = [
      ['PAYE (Income Tax)', Number(slip.paye)],
      ['UIF (Employee)', Number(slip.uif_employee)],
      ['Medical Aid', Number(slip.medical_aid)],
      ['Retirement Fund', Number(slip.retirement_fund)],
      ['Other Deductions', Number(slip.other_deductions)],
    ];

    for (const [label, amount] of deductions) {
      if (Number(amount) > 0) {
        doc.text(String(label), margin, y);
        doc.text(formatAmountRaw(Number(amount)), pageWidth - margin, y, { align: 'right' });
        y += 5;
      }
    }

    y += 2;
    const totalDed = Number(slip.paye || 0) + Number(slip.uif_employee || 0) + Number(slip.medical_aid || 0) + Number(slip.retirement_fund || 0) + Number(slip.other_deductions || 0);
    doc.setFont('helvetica', 'bold');
    doc.text('Total Deductions', margin, y);
    doc.text(formatAmountRaw(totalDed), pageWidth - margin, y, { align: 'right' });
    y += 10;

    // Net Pay
    doc.setDrawColor(0, 128, 128);
    doc.setFillColor(240, 253, 250);
    doc.rect(margin, y - 2, pageWidth - 2 * margin, 12, 'F');
    doc.setFontSize(12);
    doc.text('NET PAY', margin + 5, y + 6);
    doc.text(`R ${formatAmountRaw(Number(slip.net_pay))}`, pageWidth - margin - 5, y + 6, { align: 'right' });
    y += 18;

    // Employer costs
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('Employer Contributions:', margin, y);
    y += 5;
    doc.text(`UIF (Employer): R ${formatAmountRaw(Number(slip.uif_employer))}`, margin + 5, y);
    y += 5;
    doc.text(`SDL: R ${formatAmountRaw(Number(slip.sdl))}`, margin + 5, y);
    y += 10;

    // YTD
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Year-to-Date', margin, y);
    y += 7;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`YTD Gross: R ${formatAmountRaw(Number(slip.ytd_gross))}`, margin, y);
    y += 5;
    doc.text(`YTD PAYE: R ${formatAmountRaw(Number(slip.ytd_paye))}`, margin, y);
    y += 5;
    doc.text(`YTD UIF: R ${formatAmountRaw(Number(slip.ytd_uif))}`, margin, y);
    y += 10;

    // Banking details
    if (slip.bank_name) {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('Banking Details:', margin, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.text(`Bank: ${slip.bank_name}`, margin, y);
      y += 5;
      doc.text(`Account: ${slip.bank_account_number || '-'}`, margin, y);
      y += 5;
      doc.text(`Branch Code: ${slip.bank_branch_code || '-'}`, margin, y);
    }

    // Output PDF
    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    const fmtPeriod = (d: string | Date) => { const dt = new Date(d); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`; };
    const filename = `payslip_${slip.employee_number}_${fmtPeriod(slip.period_start)}_to_${fmtPeriod(slip.period_end)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.status(200).end(pdfBuffer);
  } catch (err) {
    log.error('payslip PDF generation failed', { id, error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to generate payslip PDF');
  }
}

function formatAmountRaw(amount: number): string {
  return amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
