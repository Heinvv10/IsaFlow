/**
 * Payroll PDF Service — Entry Point
 * Delegates PDF generation to payrollPdfBuilders1 / payrollPdfBuilders2.
 * Called by pages/api/payroll/payroll-documents.ts
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

import { fmtPeriod, buildPayRegister, buildEmp201, buildLeaveReport, type PdfCompany } from './payrollPdfBuilders1';
import { buildRemuneration, buildBatchPayslips } from './payrollPdfBuilders2';

export type { PdfCompany };
export { fmtDate, fmtPeriod } from './payrollPdfBuilders1';

export interface PdfBuildInput {
  company: PdfCompany;
  run: Row;
  payslips: Row[];
  leaveData?: Row[];
  docType: string;
}

/**
 * Build a payroll PDF document and return the buffer + suggested filename.
 */
export async function buildPayrollPdf(input: PdfBuildInput): Promise<{ buffer: Buffer; filename: string }> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  const { company, run, payslips, leaveData = [], docType } = input;

  switch (docType) {
    case 'pay-register':   buildPayRegister(doc, company, run, payslips); break;
    case 'emp201':         buildEmp201(doc, company, run, payslips); break;
    case 'leave-report':   buildLeaveReport(doc, company, run, leaveData); break;
    case 'remuneration':   buildRemuneration(doc, company, run, payslips); break;
    case 'batch-payslips': buildBatchPayslips(doc, company, run, payslips); break;
    default: throw new Error(`Unknown docType: ${docType}`);
  }

  const buffer = Buffer.from(doc.output('arraybuffer'));
  const cleanPeriod = fmtPeriod(run.period_end).replace(/\//g, '-');
  const filename = `${String(company.name).replace(/[^a-zA-Z0-9]/g, '')}-${docType}-${cleanPeriod}.pdf`;

  return { buffer, filename };
}
