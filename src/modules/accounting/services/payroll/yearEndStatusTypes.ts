/**
 * The year-end checklist's response shape and its severity count (split out of pages/api/payroll/year-end/status.ts,
 * wave 6 EF, to keep the route under 300 lines). The route re-exports `YearEndStatus`.
 */
import type { ValidationMessage } from './irp5ValidationEngine';

export interface YearEndStatus {
  taxYear: number;
  companyProfile: {
    complete: boolean;
    missing: string[];
  };
  employees: {
    total: number;
    withPayroll: number;
  };
  payrollRuns: {
    monthsCovered: number; // count of months in the tax year with at least one run
    totalPaye: number;
  };
  readiness: {
    errors: number;
    warnings: number;
    componentIssues: number;
    certificatesReady: number;
  };
  emp501: {
    balanced: boolean;
    totalEmp201: number;
    totalIrp5: number;
    totalVariance: number;
    /**
     * PSP PAYE (wave 6 PSP): on the EMP201, on no natural-person certificate, so part of the variance and never balanced
     * (the PSP certificate is not produced; UNVERIFIED). unexplainedVariance = totalVariance - pspPaye. Aggregates only.
     */
    pspPaye: number;
    unexplainedVariance: number;
  };
  periodLock: {
    locked: boolean;
    lockdownDate: string | null;
  };
  /** Approved/paid runs left out because they are not final (wave 6 EF), by name. */
  runWarnings: string[];
}

export function countSeverity(msgs: ValidationMessage[], severity: 'error' | 'warning'): number {
  return msgs.filter((m) => m.severity === severity).length;
}
