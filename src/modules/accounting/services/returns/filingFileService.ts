/**
 * Download the filing file of a return version (wave 6 EFa). The first download of a finalised version generates the
 * capture CSV and STORES it on the version with its stamps (migration 999v: the CSV, its sha256, kind, when, who) in one
 * savepoint with its audit row; every later download serves the stored CSV (the JSON and the PDF are read from it) and
 * never regenerates it, so a later change to the generator cannot strand a stamped version. Owner/admin only, Login-as
 * refused, everything judged before the one write (withAuth commits a 4xx). Mark filed then needs the stamp (fileReturn).
 * IsaFlow sends nothing to SARS: the person captures the sheet on eFiling and types the PRN back.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { buildCaptureSheet, buildVat201Json, filingFileBaseName, sha256Hex } from './filingFileContent';
import { buildCaptureSheetPdf } from './filingFilePdf';
import { assertMayActOnReturns } from './returnGuards';
import { getVersionForUpdate } from './returnVersionWrites';
import { ReturnRefusal, type ReturnActor, type ReturnForm, type ReturnVersion } from './returnVersionTypes';

export type FilingFileFormat = 'csv' | 'json' | 'pdf';
export const FILING_FILE_FORMATS: Record<ReturnForm, readonly FilingFileFormat[]> = { VAT201: ['csv', 'json'], EMP201: ['csv', 'pdf'] };
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

/**
 * Stores a FINALISED, unstamped version's filing file and stamps it (999v: the content, its sha256, kind, when, who) and
 * audits it, in one savepoint. Throws unless exactly one row was stamped. The caller holds the version row lock
 * (getVersionForUpdate) and has judged everything first. EFb calls it for the EMP501 e@syFile file. Returns the sha256.
 */
export async function stampFilingFile(
  companyId: string, v: ReturnVersion, content: string, kind: string, format: string, userId: string,
): Promise<string> {
  const sha256 = sha256Hex(content);
  await withSavepoint('filing_file', async () => {
    const stamped = (await sql`UPDATE tax_return_versions
      SET filing_file_content = ${content}, filing_file_sha256 = ${sha256}, filing_file_kind = ${kind},
        filing_file_at = now(), filing_file_by = ${userId}::TEXT
      WHERE id = ${v.id}::UUID AND company_id = ${companyId}::UUID AND status = 'finalised' AND filing_file_sha256 IS NULL
      RETURNING id`) as DbRow[];
    if (stamped.length !== 1) {
      throw new Error(`stampFilingFile: expected to stamp version ${v.id}, stamped ${stamped.length} rows`);
    }
    await logAuditOrThrow({
      companyId, userId, action: 'update', entityType: 'tax_return_version', entityId: v.id,
      entityRef: `${v.formType} ${v.periodStart} to ${v.periodEnd} v${v.versionNo}`,
      changes: {
        fields: [{ field: 'filing_file_sha256', old: null, new: sha256, label: 'Filing file' }],
        metadata: { kind, format },
      },
    });
  });
  return sha256;
}

/** The stored filing file of a stamped version (999v's CHECK keeps its sha256 equal to the stamp). */
async function storedContent(companyId: string, versionId: string): Promise<string> {
  const rows = (await sql`SELECT filing_file_content FROM tax_return_versions
    WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const content = rows[0]?.filing_file_content;
  if (typeof content !== 'string') throw new Error(`version ${versionId} is stamped but has no stored filing file`);
  return content;
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
  let csv: string;
  let sha256: string;
  let stamped = false;
  if (v.filingFileSha256) {
    csv = await storedContent(companyId, v.id); // served as stored: never regenerated
    sha256 = v.filingFileSha256;
  } else {
    const sheet = buildCaptureSheet(v); // a VAT201 without its recorded form is refused here, before any write
    csv = sheet.csv;
    sha256 = sheet.sha256;
    // A version filed before migration 999v has no stamp, and the trigger freezes the stamps once filed: serve, unstamped.
    if (v.status === 'finalised') {
      await stampFilingFile(companyId, v, csv, sheet.kind, format, actor.userId);
      stamped = true;
    }
  }
  const body = format === 'csv' ? Buffer.from(csv, 'utf8')
    : format === 'json' ? Buffer.from(buildVat201Json(csv, sha256), 'utf8')
      : await buildCaptureSheetPdf(csv, sha256, `${v.formType} capture sheet, ${v.periodStart} to ${v.periodEnd}, version ${v.versionNo}`, v.finalisedAt);
  return { body, contentType: TYPES[format], filename: `${filingFileBaseName(v)}.${format}`, sha256, stamped };
}
