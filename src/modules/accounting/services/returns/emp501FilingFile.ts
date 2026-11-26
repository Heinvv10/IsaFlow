/**
 * The e@syFile IRP5 file of a finalised EMP501 version (wave 6 EFb), built from the version's stored figures only
 * (emp501Figures), never from the live payroll: the same version always gives the same STORED bytes and the same
 * stamp (sha256). Since wave 7 EA2 (Hein's ruling 25) the bytes SERVED add each certificate's bank account, read live at
 * download (a filed version: as they stood at its filed_at, so it re-serves the bytes filed) and never stored, so a
 * version not yet filed can differ between downloads (an account changed): each download's audit row
 * records the served bytes' sha256 beside the stored one, so the exact file sent to SARS is provable later.
 * Built in memory; nothing is written to disk.
 */
import { createHash } from 'node:crypto';
import { buildIrp5File, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import type { PspCertificateInput } from '@/modules/accounting/services/payroll/easyFilePspCertificate';
import { localDay } from '@/modules/accounting/services/payroll/easyFileEmployeeFacts';
import { currentCertificate, currentEmployer, isLegacyLayout } from '@/modules/accounting/services/payroll/easyFileLegacyCertificate';
import { UsageError } from '@/modules/accounting/services/payroll/easyFileFields';
import type { Emp501Kind } from '@/modules/accounting/services/payroll/emp501Period';
import type { StoredEmployee } from './emp501Figures';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { FILING_FILE_KIND } from './filingFileContent';
import { stampFilingFile, storedContent } from './filingFileService';
import { assertMayActOnReturns } from './returnGuards';
import { getVersionForUpdate } from './returnVersionWrites';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { withLiveBankAccounts } from '@/modules/accounting/services/payroll/easyFileBankOverlay';
import type { CertificateBankReader } from '@/modules/accounting/services/payroll/easyFileBankAccounts';
import { ReturnRefusal, STALE_RETURN_REFUSAL, type ReturnActor, type ReturnVersion } from './returnVersionTypes';

export const EMP501_FILE_KIND = FILING_FILE_KIND.EMP501; // 999v's filing_file_kind CHECK: the kind and its builder version

export interface Emp501File { body: string; filename: string; sha256: string }

type StoredFigures = { taxYear: number; kind: Emp501Kind; employer: EmployerInput; employees: StoredEmployee[]; pspCertificates?: PspCertificateInput[] };

/** The download's file name, from the stored figures alone (a stamped version is served without a rebuild). */
export function emp501FileName(v: Pick<ReturnVersion, 'figures'>): string {
  const f = v.figures as StoredFigures;
  return `IRP5_${f.taxYear - 1}_${f.taxYear}_${f.employer.payeReferenceNumber}${f.kind === 'interim' ? '_08' : ''}.irp5`;
}

export function emp501FileOf(v: Pick<ReturnVersion, 'formType' | 'figures'>): Emp501File {
  if (v.formType !== 'EMP501') throw new Error(`emp501FileOf: a ${v.formType} version has no e@syFile file`);
  const f = v.figures as StoredFigures;
  // Figures stored before the BRS code fix are read in today's shape (easyFileLegacyCertificate): the certificates'
  // tax period and pay periods, and no province under 2065. The date of birth is stored as its calendar day
  // (storeEmployee); the builder reads a local-midnight Date (localDay).
  const legacy = isLegacyLayout(f.employees);
  let body: string;
  try {
    const employees: EmployeeInput[] = f.employees.map((s) => currentCertificate(s, f.taxYear, f.kind)).map(({ dateOfBirth, ...e }) =>
      (dateOfBirth === undefined ? e : { ...e, dateOfBirth: dateOfBirth === null ? null : localDay(dateOfBirth) }));
    body = buildIrp5File({ employer: currentEmployer(f.employer, legacy), employees, pspCertificates: f.pspCertificates });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    // A version finalised before the fix may break a rule its rebuild now applies (a missing income tax number under
    // PAYE): refused by name, with the way out. The version itself is never changed.
    throw new ReturnRefusal(409, legacy
      ? `This version was finalised before the e@syFile code fix, and its file cannot be rebuilt: ${err.message} `
        + 'Correct it (for example, add the income tax number on the employee record), then amend the return and finalise it again.'
      : `The e@syFile file cannot be built from this version: ${err.message}`);
  }
  return { body, filename: emp501FileName(v), sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
}

/**
 * Download an EMP501 version's e@syFile file (wave 6 EFb), as EFa's downloadFilingFile does for VAT201/EMP201: owner/
 * admin only, Login-as refused, row-locked so concurrent first downloads stamp once. The first download of a finalised
 * version builds the file from the stored figures and stores it with its stamp (999v) and audit row in one savepoint;
 * every later download serves the stored bytes, never a rebuilt file (ruling H2). A superseded version is refused (409).
 * Everything is judged before the one write. The bytes served carry each certificate's bank account, read live for
 * `bankReader` (wave 7 EA2, Hein's ruling 25: easyFileBankOverlay; never stored); the stamp is the stored file's.
 */
export async function downloadEmp501File(
  companyId: string, versionId: string, actor: ReturnActor, bankReader?: CertificateBankReader,
): Promise<{ filename: string; body: string; storedSha256: string; servedSha256: string; stamped: boolean }> {
  const file = await downloadStoredEmp501File(companyId, versionId, actor);
  const f = file.figures as { employees?: StoredEmployee[]; certificateEmployees?: Array<{ certificateNumber: string; employeeId: string }> };
  const names = new Map((f.employees ?? []).map((e) => [e.certificateNumber, `${e.firstNames} ${e.surname}`.trim()]));
  // A filed version: the accounts as they stood when it was filed (PII breaker of #1944: its re-download must be the
  // bytes submitted); otherwise today's.
  const body = await withLiveBankAccounts(companyId, file.body, f.certificateEmployees, names, bankReader, file.filedAt ?? undefined);
  const servedSha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  // Every download (not only the stamping one): which bytes left, by hash only; never a bank value.
  await logAuditOrThrow({
    companyId, userId: actor.userId, action: 'export', entityType: 'tax_return_version', entityId: versionId,
    changes: { fields: [], metadata: { file: 'emp501_easyfile', storedSha256: file.sha256, servedSha256, liveBankFields: String(body !== file.body) } },
  });
  return { filename: file.filename, body, storedSha256: file.sha256, servedSha256, stamped: file.stamped };
}

async function downloadStoredEmp501File(
  companyId: string, versionId: string, actor: ReturnActor,
): Promise<Emp501File & { stamped: boolean; figures: unknown; filedAt?: string | null }> {
  await assertNotImpersonating(); // a stamp names the person
  assertMayActOnReturns(actor.role, 'file');
  const v = await getVersionForUpdate(companyId, versionId);
  if (!v || v.formType !== 'EMP501') throw new ReturnRefusal(404, 'Return version not found.');
  if (v.status === 'superseded') {
    throw new ReturnRefusal(409, `Version ${v.versionNo} was superseded by an amend. Download the current version's file.`,
      STALE_RETURN_REFUSAL.VERSION_SUPERSEDED);
  }
  if (v.filingFileSha256) {
    // A stamp in the current layout, or a FILED version's (the record of what was filed, in whatever layout): the stored bytes.
    if (v.filingFileKind === EMP501_FILE_KIND || v.status === 'filed') {
      return { filename: emp501FileName(v), body: await storedContent(companyId, v.id), sha256: v.filingFileSha256, stamped: false, figures: v.figures, filedAt: v.status === 'filed' ? v.filedAt : null };
    }
    // Stamped in an earlier layout and not filed (emp501LayoutNote says so on the bar): rebuilt in the current layout,
    // not stored (999v writes a stamp once); amending and finalising again stamps the current file.
    return { ...emp501FileOf(v), stamped: false, figures: v.figures, filedAt: null }; // not filed (a filed one served its bytes above)
  }
  const file = emp501FileOf(v); // unstamped: the bytes (a version that cannot build one is refused here)
  if (v.status !== 'finalised') return { ...file, stamped: false, figures: v.figures, filedAt: v.status === 'filed' ? v.filedAt : null }; // filed before 999v: the trigger keeps it unstamped
  const sha256 = await stampFilingFile(companyId, v, file.body, EMP501_FILE_KIND, 'irp5', actor.userId);
  return { ...file, sha256, stamped: true, figures: v.figures, filedAt: null }; // finalised, not filed
}
