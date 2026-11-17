/**
 * The e@syFile IRP5 file of a finalised EMP501 version (wave 6 EFb), built from the version's stored figures only
 * (emp501Figures), never from the live payroll: the same version always gives the same bytes and the same sha256.
 * Built in memory; nothing is written to disk.
 */
import { createHash } from 'node:crypto';
import { buildIrp5File, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import type { ReturnVersion } from './returnVersionTypes';

export const EMP501_FILE_KIND = 'emp501_easyfile'; // 999v's filing_file_kind CHECK

export interface Emp501File { body: string; filename: string; sha256: string }

export function emp501FileOf(v: Pick<ReturnVersion, 'formType' | 'figures'>): Emp501File {
  if (v.formType !== 'EMP501') throw new Error(`emp501FileOf: a ${v.formType} version has no e@syFile file`);
  const f = v.figures as { taxYear: number; kind: string; employer: EmployerInput; employees: EmployeeInput[] };
  const body = buildIrp5File({ employer: f.employer, employees: f.employees });
  const filename = `IRP5_${f.taxYear - 1}_${f.taxYear}_${f.employer.payeReferenceNumber}${f.kind === 'interim' ? '_08' : ''}.irp5`;
  return { body, filename, sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
}
