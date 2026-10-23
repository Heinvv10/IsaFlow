/**
 * The durable record that a bank file was generated for a batch, and its release (AP-01). A file is a way of paying:
 * a batch with a file must not also go to Netcash (netcash/submit), unless someone has said the file was not used.
 *
 * Stored in audit_log (append-only for app_user, migration 880), entity_type 'batch_bank_file', entity_id = the batch:
 *   action 'export'  one row per file served (eft-generate), metadata.bank = the bank format.
 *   action 'update'  a release (eft-file-release): metadata.releases = the export row ids it releases (comma
 *                    separated), metadata.reason = the required reason. A release names exports, not a time, so a
 *                    file generated afterwards is a NEW unreleased export and blocks again - no clock comparison.
 * audit_log's action CHECK has no 'bank_file_released', so a release is an 'update' of the 'batch_bank_file' entity.
 *
 * Call these with the batch row ALREADY locked by this transaction (FOR NO KEY UPDATE in eft-generate and the release
 * route, FOR SHARE in netcash/submit): the writers serialise on the lock, and a reader sees every committed export.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';

const ENTITY_TYPE = 'batch_bank_file';

export interface UnreleasedBankFile { id: string; bank: string | null; generatedAt: string; generatedBy: string }

/** Records a file about to be served. Throws if the record cannot be written: no file without its row. */
export async function recordBankFileGenerated(p: {
  companyId: string; batchId: string; batchNumber: string; bank: string; userId: string; userEmail?: string;
}): Promise<void> {
  await logAuditOrThrow({
    companyId: p.companyId, userId: p.userId, userEmail: p.userEmail, action: 'export', entityType: ENTITY_TYPE,
    entityId: p.batchId, entityRef: p.batchNumber.slice(0, 100),
    changes: { fields: [], metadata: { bank: p.bank } },
  });
}

/** The batch's exports no release names, newest first. */
export async function unreleasedBankFiles(companyId: string, batchId: string): Promise<UnreleasedBankFile[]> {
  const rows = (await sql`
    SELECT e.id, e.created_at, e.user_email, e.user_id, e.changes -> 'metadata' ->> 'bank' AS bank
    FROM audit_log e
    WHERE e.company_id = ${companyId}::UUID AND e.entity_type = ${ENTITY_TYPE} AND e.entity_id = ${batchId}::UUID
      AND e.action = 'export'
      AND NOT EXISTS (
        SELECT 1 FROM audit_log r
        WHERE r.company_id = e.company_id AND r.entity_type = e.entity_type AND r.entity_id = e.entity_id
          AND r.action = 'update'
          AND e.id::TEXT = ANY (string_to_array(r.changes -> 'metadata' ->> 'releases', ','))
      )
    ORDER BY e.created_at DESC
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id), bank: r.bank ? String(r.bank) : null,
    generatedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    generatedBy: String(r.user_email ?? r.user_id),
  }));
}

export async function unreleasedBankFile(companyId: string, batchId: string): Promise<UnreleasedBankFile | null> {
  return (await unreleasedBankFiles(companyId, batchId))[0] ?? null;
}

/** Releases every export of the batch not yet released. 0 when there is nothing to release. */
export async function releaseBankFiles(p: {
  companyId: string; batchId: string; batchNumber: string; reason: string; userId: string; userEmail?: string;
}): Promise<number> {
  const open = await unreleasedBankFiles(p.companyId, p.batchId);
  if (open.length === 0) return 0;
  await logAuditOrThrow({
    companyId: p.companyId, userId: p.userId, userEmail: p.userEmail, action: 'update', entityType: ENTITY_TYPE,
    entityId: p.batchId, entityRef: p.batchNumber.slice(0, 100),
    changes: { fields: [], metadata: { releases: open.map((f) => f.id).join(','), reason: p.reason } },
  });
  return open.length;
}
