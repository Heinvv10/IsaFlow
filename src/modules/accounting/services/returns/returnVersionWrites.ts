/** The two UPDATEs of tax_return_versions (wave 5 L1b, migration 971): a filing and an amend. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { mapVersion } from './returnVersionStore';
import type { ReturnVersion } from './returnVersionTypes';

/** One version of this company, row-locked until the transaction ends; null when it is not this company's. */
export async function getVersionForUpdate(companyId: string, versionId: string): Promise<ReturnVersion | null> {
  const rows = (await sql`
    SELECT * FROM tax_return_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID FOR UPDATE
  `) as DbRow[];
  return rows[0] ? mapVersion(rows[0]) : null;
}

/** finalised -> filed. The trigger refuses any other starting status and any second stamping. */
export async function markVersionFiled(
  companyId: string, versionId: string, submissionId: string, reference: string, userId: string,
): Promise<ReturnVersion> {
  const rows = (await sql`
    UPDATE tax_return_versions
    SET status = 'filed', sars_submission_id = ${submissionId}::UUID, filed_reference = ${reference},
        filed_by = ${userId}::TEXT, filed_at = now()
    WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID AND status = 'finalised'
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error(`Return version ${versionId} could not be marked filed`);
  return mapVersion(rows[0]);
}

/** finalised or filed -> superseded, with the amend stamps (all three, or the CHECK refuses). */
export async function markVersionSuperseded(
  companyId: string, versionId: string, userId: string, reason: string,
): Promise<ReturnVersion> {
  const rows = (await sql`
    UPDATE tax_return_versions
    SET status = 'superseded', amended_by = ${userId}::TEXT, amend_reason = ${reason}, amended_at = now()
    WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID AND status <> 'superseded'
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error(`Return version ${versionId} could not be superseded`);
  return mapVersion(rows[0]);
}

/** Whether a VAT201 version's lock still locks (false once somebody unlocked it directly). */
export async function isLockActive(companyId: string, lockId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT unlocked_at FROM vat_period_locks WHERE id = ${lockId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0] !== undefined && rows[0].unlocked_at == null;
}

/** The form of a version, read without a lock (to take the VAT key before the row lock). */
export async function peekForm(companyId: string, versionId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT form_type FROM tax_return_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0] ? String(rows[0].form_type) : null;
}
