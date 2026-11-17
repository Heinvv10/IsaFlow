/**
 * The e@syFile IRP5 file of a finalised EMP501 version (wave 6 EFb), built from the version's stored figures only
 * (emp501Figures), never from the live payroll: the same version always gives the same bytes and the same sha256.
 * Built in memory; nothing is written to disk.
 */
import { createHash } from 'node:crypto';
import { buildIrp5File, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { sql, withSavepoint } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { assertMayActOnReturns } from './returnGuards';
import { getVersionForUpdate } from './returnVersionWrites';
import { ReturnRefusal, STALE_RETURN_REFUSAL, type ReturnActor, type ReturnVersion } from './returnVersionTypes';

export const EMP501_FILE_KIND = 'emp501_easyfile'; // 999v's filing_file_kind CHECK

export interface Emp501File { body: string; filename: string; sha256: string }

export function emp501FileOf(v: Pick<ReturnVersion, 'formType' | 'figures'>): Emp501File {
  if (v.formType !== 'EMP501') throw new Error(`emp501FileOf: a ${v.formType} version has no e@syFile file`);
  const f = v.figures as { taxYear: number; kind: string; employer: EmployerInput; employees: EmployeeInput[] };
  const body = buildIrp5File({ employer: f.employer, employees: f.employees });
  const filename = `IRP5_${f.taxYear - 1}_${f.taxYear}_${f.employer.payeReferenceNumber}${f.kind === 'interim' ? '_08' : ''}.irp5`;
  return { body, filename, sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
}

/**
 * Download an EMP501 version's e@syFile file (wave 6 EFb), as EFa's downloadFilingFile does for VAT201/EMP201: owner/
 * admin only, Login-as refused, row-locked so concurrent first downloads stamp once; the first download of a finalised
 * version stamps it (999v) with its audit row in one savepoint; a later download is checked against the stamp
 * (409 FILING_FILE_MISMATCH); a superseded version is refused (409). Everything is judged before the one write.
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
  const file = emp501FileOf(v);
  if (v.filingFileSha256 && v.filingFileSha256 !== file.sha256) {
    throw new ReturnRefusal(409, `Version ${v.versionNo}'s e@syFile file no longer regenerates to the file stamped on it `
      + `(${v.filingFileSha256}). Nothing was downloaded; report this to support.`, 'FILING_FILE_MISMATCH');
  }
  const stamp = v.filingFileSha256 === null && v.status === 'finalised';
  if (stamp) {
    await withSavepoint('emp501_filing_file', async () => {
      await sql`UPDATE tax_return_versions
        SET filing_file_sha256 = ${file.sha256}, filing_file_kind = ${EMP501_FILE_KIND}, filing_file_at = now(), filing_file_by = ${actor.userId}::TEXT
        WHERE id = ${v.id}::UUID AND company_id = ${companyId}::UUID AND status = 'finalised' AND filing_file_sha256 IS NULL`;
      await logAuditOrThrow({
        companyId, userId: actor.userId, action: 'update', entityType: 'tax_return_version', entityId: v.id,
        entityRef: `${v.formType} ${v.periodStart} to ${v.periodEnd} v${v.versionNo}`,
        changes: { fields: [{ field: 'filing_file_sha256', old: null, new: file.sha256, label: 'Filing file' }], metadata: { kind: EMP501_FILE_KIND } },
      });
    });
  }
  return { ...file, stamped: stamp };
}
