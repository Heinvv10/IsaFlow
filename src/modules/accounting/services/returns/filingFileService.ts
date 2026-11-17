/**
 * Download the filing file of a return version (wave 6 EFa). The first download of a finalised version stamps it
 * (migration 999v: sha256 of the capture CSV, kind, when, who) in one savepoint with its audit row; every later
 * download regenerates the same bytes from the version row and is checked against the stamp. Owner/admin only, Login-as
 * refused, everything judged before the one write (withAuth commits a 4xx). Mark filed then needs the stamp (fileReturn).
 * IsaFlow sends nothing to SARS: the person captures the sheet on eFiling and types the PRN back.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { buildCaptureSheet, buildVat201Json } from './filingFileContent';
import { buildCaptureSheetPdf } from './filingFilePdf';
import { assertMayActOnReturns } from './returnGuards';
import { getVersionForUpdate } from './returnVersionWrites';
import { ReturnRefusal, type ReturnActor, type ReturnForm } from './returnVersionTypes';

export type FilingFileFormat = 'csv' | 'json' | 'pdf';
// EMP501's e@syFile file has its own payroll-detail service and route (emp501FilingFile, wave 6 EFb): none here.
export const FILING_FILE_FORMATS: Record<ReturnForm, readonly FilingFileFormat[]> = { VAT201: ['csv', 'json'], EMP201: ['csv', 'pdf'], EMP501: [] };
const TYPES: Record<FilingFileFormat, string> = { csv: 'text/csv; charset=utf-8', json: 'application/json', pdf: 'application/pdf' };

export interface FilingFile {
  body: Buffer;
  contentType: string;
  filename: string;
  /** The stamped capture sheet's sha256 (the PDF and JSON carry it too). */
  sha256: string;
  /** True when this download wrote the stamp. */
  stamped: boolean;
}

export async function downloadFilingFile(
  companyId: string, form: ReturnForm, versionId: string, format: FilingFileFormat, actor: ReturnActor,
): Promise<FilingFile> {
  await assertNotImpersonating(); // a stamp names the person: refused to a Login-as session
  assertMayActOnReturns(actor.role, 'file');
  if (!FILING_FILE_FORMATS[form].includes(format)) {
    throw new ReturnRefusal(400, `The ${form} filing file is ${FILING_FILE_FORMATS[form].join(' or ')}.`);
  }
  const v = await getVersionForUpdate(companyId, versionId); // concurrent first downloads stamp once
  if (!v || v.formType !== form) throw new ReturnRefusal(404, 'Return version not found.');
  if (v.status === 'superseded') {
    throw new ReturnRefusal(409, `Version ${v.versionNo} was superseded by an amend. Download the current version's file.`);
  }
  const sheet = buildCaptureSheet(v);
  if (v.filingFileSha256 && v.filingFileSha256 !== sheet.sha256) {
    throw new ReturnRefusal(409, `Version ${v.versionNo}'s filing file no longer regenerates to the file stamped on it `
      + `(${v.filingFileSha256}). Nothing was downloaded; report this to support.`, 'FILING_FILE_MISMATCH');
  }
  // A version filed before migration 999v has no stamp, and the trigger freezes the stamps once filed: serve, unstamped.
  const stamp = v.filingFileSha256 === null && v.status === 'finalised';
  if (stamp) {
    await withSavepoint('filing_file', async () => {
      await sql`UPDATE tax_return_versions
        SET filing_file_sha256 = ${sheet.sha256}, filing_file_kind = ${sheet.kind}, filing_file_at = now(), filing_file_by = ${actor.userId}::TEXT
        WHERE id = ${v.id}::UUID AND company_id = ${companyId}::UUID AND status = 'finalised' AND filing_file_sha256 IS NULL`;
      await logAuditOrThrow({
        companyId, userId: actor.userId, action: 'update', entityType: 'tax_return_version', entityId: v.id,
        entityRef: `${v.formType} ${v.periodStart} to ${v.periodEnd} v${v.versionNo}`,
        changes: {
          fields: [{ field: 'filing_file_sha256', old: null, new: sheet.sha256, label: 'Filing file' }],
          metadata: { kind: sheet.kind, format },
        },
      });
    });
  }
  const body = format === 'csv' ? Buffer.from(sheet.csv, 'utf8')
    : format === 'json' ? Buffer.from(buildVat201Json(v, sheet), 'utf8')
      : await buildCaptureSheetPdf(sheet, `${v.formType} capture sheet, ${v.periodStart} to ${v.periodEnd}, version ${v.versionNo}`, v.finalisedAt);
  return { body, contentType: TYPES[format], filename: `${sheet.baseName}.${format}`, sha256: sheet.sha256, stamped: stamp };
}
