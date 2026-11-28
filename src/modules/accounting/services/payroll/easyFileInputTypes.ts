/**
 * The e@syFile input's types and its refusal (moved out of easyFileInput.ts for the 300-line cap; easyFileInput
 * re-exports them, so every importer is as before).
 */
import type { EmployerInput, EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import type { PspCertificateInput } from '@/modules/accounting/services/payroll/easyFilePspCertificate';

/** A refusal the route answers as-is: 404 (no company), 422 VALIDATION_ERROR, or 400. */
export class EasyFileInputRefusal extends Error {
  constructor(readonly kind: 'not_found' | 'validation' | 'bad_request', message: string,
    readonly details: Record<string, unknown> | undefined = undefined) {
    super(message);
    this.name = 'EasyFileInputRefusal';
  }
}

export interface EasyFileInput {
  employer: EmployerInput;
  employees: EmployeeInput[];
  payeRef: string;
  /** Capped for the header (capWarningsForHeader). */
  warnings: string[];
  warningsTotal: number;
  unlinkedPaymentIds: string[];
  /** The payroll employee each certificate is for, by certificate number (wave 6 SS-c: the employee portal's IRP5). */
  certificateEmployees: Array<{ certificateNumber: string; employeeId: string }>;
  /** Wave 6 PSP-H: each PSP's own H certificate, numbered after the natural persons'. */
  pspCertificates: PspCertificateInput[];
}
