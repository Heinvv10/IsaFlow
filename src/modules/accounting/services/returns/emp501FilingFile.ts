/**
 * The e@syFile IRP5 file of a finalised EMP501 version (wave 6 EFb), built from the version's stored figures only
 * (emp501Figures), never from the live payroll: the same version always gives the same bytes and the same sha256.
 * Built in memory; nothing is written to disk.
 */
import { createHash } from 'node:crypto';
import { buildIrp5File, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ReturnRefusal, STALE_RETURN_REFUSAL, type ReturnVersion } from './returnVersionTypes';

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
 * Stamp the file on a finalised version (999v: once, by the session user, frozen once filed). A version already
 * stamped is not written again: its stored figures give the same bytes, and a different hash is a defect, raised.
 */
export async function stampEmp501File(companyId: string, v: ReturnVersion, file: Emp501File, userId: string): Promise<void> {
  if (v.filingFileSha256) {
    if (v.filingFileSha256 !== file.sha256) throw new Error(`EMP501 version ${v.id}: the filing file no longer matches its stamp`);
    return;
  }
  if (v.status !== 'finalised') {
    throw new ReturnRefusal(409, `Version ${v.versionNo} was amended. Download the current version's file.`, STALE_RETURN_REFUSAL.VERSION_SUPERSEDED);
  }
  const rows = (await sql`
    UPDATE tax_return_versions
    SET filing_file_sha256 = ${file.sha256}, filing_file_kind = ${EMP501_FILE_KIND}, filing_file_at = now(), filing_file_by = ${userId}::TEXT
    WHERE id = ${v.id}::UUID AND company_id = ${companyId}::UUID AND status = 'finalised' AND filing_file_sha256 IS NULL
    RETURNING id
  `) as DbRow[];
  if (!rows[0]) throw new Error(`EMP501 version ${v.id} could not be stamped`);
}
