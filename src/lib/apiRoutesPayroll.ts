/**
 * Payroll routes of the route registry added in wave 6, kept beside `apiRoutes.ts` (at the file-size limit);
 * `DynamicRoutes` there extends this. Same rules: one type per URL, taken from the service, `{}` binds one segment.
 * Every import is `import type`.
 */
import type { RunBankFileState } from '@/modules/accounting/services/payroll/payrollBankFileStatus';
import type { GeneratedBankFile } from '@/modules/accounting/services/payroll/payrollBankFileService';

export interface PayrollDynamicRoutes {
  // Wave 6 BF: GET the run's files and the switch; POST generates one file (a union, see apiRoutes.ts).
  '/api/payroll/runs/{}/bank-file': RunBankFileState | GeneratedBankFile;
}
