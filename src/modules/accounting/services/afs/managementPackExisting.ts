/**
 * A month holds one management pack. Rebuilding a month replaces its draft, or a pack made before a change (a note
 * approved, a section turned on) could never show it.
 *
 * Only a draft nobody has acted on goes. A signed-off pack is a record, and so is a draft that was reviewed, signed
 * off section by section, accepted or overridden, commented on or emailed (delivering leaves the status 'draft'; its
 * email links to this document id). Sections, comments and the generation log cascade (migrations 334, 336), so this
 * is the last look. "Emailed" reads email_log by subject, so any sent pack email for the month counts: it fails closed.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '../core/auditTrailService';
import { packEmailSubjectEnd } from './packDeliveryService';

export class PackNotReplaceableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackNotReplaceableError';
  }
}

export async function checkExisting(companyId: string, period: string): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM afs_documents
    WHERE company_id = ${companyId}::UUID AND document_type = 'management_pack' AND period = ${period}
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

/** Removes the month's unlocked draft, if there is one; any other pack is left for the duplicate refusal. */
export async function removeDraftPack(companyId: string, period: string, actorUserId: string): Promise<void> {
  await assertNotImpersonating();
  const drafts = (await sql`
    SELECT id::TEXT AS id, locked_at FROM afs_documents
    WHERE company_id = ${companyId}::UUID AND document_type = 'management_pack' AND period = ${period}
      AND status = 'draft'
    FOR UPDATE
  `) as Array<{ id: string; locked_at: unknown }>;
  const draft = drafts[0];
  if (!draft) return;
  if (draft.locked_at) throw new PackNotReplaceableError(`The ${period} management pack is locked, so it stays as it is and cannot be regenerated.`);

  const acted = (await sql`
    SELECT
      EXISTS (SELECT 1 FROM afs_sections s WHERE s.document_id = ${draft.id}::UUID AND s.company_id = ${companyId}::UUID
              AND (s.reviewed_at IS NOT NULL OR s.signed_off_at IS NOT NULL OR s.ai_narrative_accepted OR s.overrides IS NOT NULL)) AS reviewed,
      EXISTS (SELECT 1 FROM afs_section_comments c JOIN afs_sections s ON s.id = c.section_id AND s.company_id = c.company_id
              WHERE s.document_id = ${draft.id}::UUID AND c.company_id = ${companyId}::UUID) AS commented,
      EXISTS (SELECT 1 FROM email_log e WHERE e.company_id = ${companyId}::UUID AND e.status = 'sent'
              AND right(e.subject, ${packEmailSubjectEnd(period).length}) = ${packEmailSubjectEnd(period)}) AS emailed
  `) as Array<{ reviewed: boolean; commented: boolean; emailed: boolean }>;
  const why = acted[0]?.emailed ? 'has been emailed' : acted[0]?.reviewed ? 'has been reviewed, signed off or edited'
    : acted[0]?.commented ? 'has comments' : null;
  if (why) throw new PackNotReplaceableError(`The ${period} management pack ${why}, so it stays as it is and cannot be regenerated.`);

  await logAuditOrThrow({
    companyId, userId: actorUserId, action: 'delete', entityType: 'management_pack', entityId: draft.id,
    entityRef: `Management pack ${period}`, changes: { fields: [], metadata: { reason: 'regenerated', period } },
  });
  await sql`DELETE FROM afs_documents WHERE id = ${draft.id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'`;
  log.info('Draft management pack replaced', { companyId, period, documentId: draft.id, actorUserId }, 'managementPackExisting');
}
