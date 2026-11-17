/**
 * The e@syFile IRP5 file of a finalised EMP501 version (wave 6 EFb), built from the version's stored figures only
 * (emp501Figures), never from the live payroll: the same version always gives the same bytes and the same sha256.
 * Built in memory; nothing is written to disk.
 */
import { createHash } from 'node:crypto';
import { buildIrp5File, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { FILING_FILE_KIND } from './filingFileContent';
import { stampFilingFile, storedContent } from './filingFileService';
import { assertMayActOnReturns } from './returnGuards';
import { getVersionForUpdate } from './returnVersionWrites';
import { ReturnRefusal, STALE_RETURN_REFUSAL, type ReturnActor, type ReturnVersion } from './returnVersionTypes';

export const EMP501_FILE_KIND = FILING_FILE_KIND.EMP501; // 999v's filing_file_kind CHECK: the kind and its builder version

export interface Emp501File { body: string; filename: string; sha256: string }

export function emp501FileOf(v: Pick<ReturnVersion, 'formType' | 'figures'>): Emp501File {
  if (v.formType !== 'EMP501') throw new Error(`emp501FileOf: a ${v.formType} version has no e@syFile file`);
  const f = v.figures as { taxYear: number; kind: string; employer: EmployerInput; employees: EmployeeInput[] };
  // JSONB stores the date of birth as an ISO string; the builder reads it as a Date.
  const employees = f.employees.map((e) => (typeof e.dateOfBirth === 'string' ? { ...e, dateOfBirth: new Date(e.dateOfBirth) } : e));
  const body = buildIrp5File({ employer: f.employer, employees });
  const filename = `IRP5_${f.taxYear - 1}_${f.taxYear}_${f.employer.payeReferenceNumber}${f.kind === 'interim' ? '_08' : ''}.irp5`;
  return { body, filename, sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
}

/**
 * Download an EMP501 version's e@syFile file (wave 6 EFb), as EFa's downloadFilingFile does for VAT201/EMP201: owner/
 * admin only, Login-as refused, row-locked so concurrent first downloads stamp once. The first download of a finalised
 * version builds the file from the stored figures and stores it with its stamp (999v) and audit row in one savepoint;
 * every later download serves the stored bytes, never a rebuilt file (ruling H2). A superseded version is refused (409).
 * Everything is judged before the one write.
 */
export async function downloadEmp501File(companyId: string, versionId: string, actor: ReturnActor): Promise<Emp501File & { stamped: boolean }> {
  await assertNotImpersonating(); // a stamp names the person
  assertMayActOnReturns(actor.role, 'file');
  const v = await getVersionForUpdate(companyId, versionId);
  if (!v || v.formType !== 'EMP501') throw new ReturnRefusal(404, 'Return version not found.');
  if (v.status === 'superseded') {
    throw new ReturnRefusal(409, `Version ${v.versionNo} was superseded by an amend. Download the current version's file.`,
      STALE_RETURN_REFUSAL.VERSION_SUPERSEDED);
  }
  const file = emp501FileOf(v); // the name; and, unstamped, the bytes (a version that cannot build one is refused here)
  if (v.filingFileSha256) {
    return { filename: file.filename, body: await storedContent(companyId, v.id), sha256: v.filingFileSha256, stamped: false };
  }
  if (v.status !== 'finalised') return { ...file, stamped: false }; // filed before 999v: the trigger keeps it unstamped
  const sha256 = await stampFilingFile(companyId, v, file.body, EMP501_FILE_KIND, 'irp5', actor.userId);
  return { ...file, sha256, stamped: true };
}
