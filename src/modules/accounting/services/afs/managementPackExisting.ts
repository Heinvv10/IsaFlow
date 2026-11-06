/**
 * Rebuilding a month's management pack replaces its draft. A month holds one pack, so without this a pack made before
 * a change (a note approved, a section turned on) could never show it. Only an unlocked draft goes: a signed-off or
 * delivered pack is a record, and stays, so the generator then refuses it as a duplicate. Sections and the generation
 * log cascade (migrations 334, 336).
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

/** A month holds one management pack. */
export async function checkExisting(companyId: string, period: string): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM afs_documents
    WHERE company_id = ${companyId}::UUID AND document_type = 'management_pack' AND period = ${period}
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

export async function removeDraftPack(companyId: string, period: string): Promise<void> {
  const removed = (await sql`
    DELETE FROM afs_documents
    WHERE company_id = ${companyId}::UUID AND document_type = 'management_pack' AND period = ${period}
      AND status = 'draft' AND locked_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  if (removed.length > 0) {
    log.info('Draft management pack replaced', { companyId, period, documentIds: removed.map((r) => r.id) }, 'managementPackExisting');
  }
}
