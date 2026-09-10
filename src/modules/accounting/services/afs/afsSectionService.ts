import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertPersonalReview, isSectionAttested, lockSectionForWrite, voidSectionAttestation } from './afsSectionAttestation';
import type {
  AfsSection,
  SectionType,
  SectionStatus,
  NoteContent,
  CreateAfsSectionInput,
  UpdateAfsSectionInput,
  AfsSectionVersionEntry,
} from './afsTypes';

function rowToAfsSection(row: Record<string, unknown>): AfsSection {
  return {
    id:                   row.id as string,
    documentId:           row.document_id as string,
    companyId:            row.company_id as string,
    sectionType:          row.section_type as SectionType,
    sortOrder:            Number(row.sort_order),
    status:               row.status as SectionStatus,
    dataSnapshot:         (row.data_snapshot as Record<string, unknown> | null) ?? null,
    content:              (row.content as NoteContent | null) ?? null,
    overrides:            (row.overrides as Partial<NoteContent> | null) ?? null,
    aiNarrative:          (row.ai_narrative as string | null) ?? null,
    aiNarrativeAccepted:  Boolean(row.ai_narrative_accepted),
    reviewedBy:           (row.reviewed_by as string | null) ?? null,
    reviewedAt:           row.reviewed_at instanceof Date ? row.reviewed_at
                            : row.reviewed_at != null ? new Date(row.reviewed_at as string) : null,
    signedOffBy:          (row.signed_off_by as string | null) ?? null,
    signedOffAt:          row.signed_off_at instanceof Date ? row.signed_off_at
                            : row.signed_off_at != null ? new Date(row.signed_off_at as string) : null,
    versionHistory:       Array.isArray(row.version_history)
                            ? (row.version_history as AfsSectionVersionEntry[])
                            : [],
    createdAt:            row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
    updatedAt:            row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
  };
}

export async function createAfsSection(input: CreateAfsSectionInput): Promise<AfsSection> {
  log.info('Creating AFS section', { documentId: input.documentId, sectionType: input.sectionType }, 'afsSectionService');

  const rows = await sql`
    INSERT INTO afs_sections (document_id, company_id, section_type, sort_order)
    VALUES (${input.documentId}::UUID, ${input.companyId}::UUID, ${input.sectionType}, ${input.sortOrder})
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Failed to create AFS section');
  }

  return rowToAfsSection(rows[0] as Record<string, unknown>);
}

export async function getAfsSectionsForDocument(documentId: string, companyId: string): Promise<AfsSection[]> {
  const rows = await sql`
    SELECT * FROM afs_sections
    WHERE document_id = ${documentId}::UUID
      AND company_id  = ${companyId}::UUID
    ORDER BY sort_order ASC, created_at ASC
  `;

  return rows.map(r => rowToAfsSection(r as Record<string, unknown>));
}

export async function updateAfsSection(
  sectionId: string,
  documentId: string,
  companyId: string,
  input: UpdateAfsSectionInput
): Promise<AfsSection> {
  // Keyed on the transition as well as the actor: a caller-supplied reviewer or signatory
  // is an approver of record arriving as input, and so is moving the section's status to
  // reviewed or signed off without naming one.
  if (input.reviewedBy || input.signedOffBy || input.status === 'reviewed' || input.status === 'signed_off') {
    assertPersonalReview();
  }
  log.info('Updating AFS section', { sectionId, documentId, status: input.status }, 'afsSectionService');

  // Bound to this document and refused while it is signed off or filed, content or not.
  const section = await lockSectionForWrite(companyId, documentId, sectionId);
  // Everything the statements or the portal show is content: the note's blocks, the overrides
  // that replace them, the AI narrative shown when there are none, the data snapshot that
  // carries a suppression, and a status moved anywhere other than to a fresh attestation. A
  // change to any of them is not what was reviewed, so the old attestation is voided — recorded
  // against whoever made the change, so an attested section cannot change anonymously. An
  // update that names the new reviewer or signatory still voids: it is the OTHER one, and its
  // timestamp, that would otherwise ride along onto content nobody attested.
  const attestsNewContent = input.status === 'reviewed' || input.status === 'signed_off';
  const changesContent = input.content !== undefined || input.overrides !== undefined
    || input.aiNarrative !== undefined || input.aiNarrativeAccepted !== undefined
    || input.dataSnapshot !== undefined || (input.status !== undefined && !attestsNewContent);
  if (changesContent && isSectionAttested(section)) {
    const actor = input.updatedBy ?? input.reviewedBy ?? input.signedOffBy;
    if (!actor) {
      throw new Error('Changing the content of a reviewed or signed-off section requires updatedBy');
    }
    await voidSectionAttestation(companyId, section, actor, 'Section content updated');
  }

  const rows = await sql`
    UPDATE afs_sections
    SET
      status                = COALESCE(${input.status ?? null}, status),
      data_snapshot         = COALESCE(${input.dataSnapshot ? JSON.stringify(input.dataSnapshot) : null}::JSONB, data_snapshot),
      content               = COALESCE(${input.content ? JSON.stringify(input.content) : null}::JSONB, content),
      overrides             = COALESCE(${input.overrides ? JSON.stringify(input.overrides) : null}::JSONB, overrides),
      ai_narrative          = COALESCE(${input.aiNarrative ?? null}, ai_narrative),
      ai_narrative_accepted = COALESCE(${input.aiNarrativeAccepted ?? null}, ai_narrative_accepted),
      reviewed_by           = COALESCE(${input.reviewedBy ?? null}, reviewed_by),
      reviewed_at           = CASE WHEN ${input.reviewedBy ?? null}::TEXT IS NOT NULL THEN now() ELSE reviewed_at END,
      signed_off_by         = COALESCE(${input.signedOffBy ?? null}, signed_off_by),
      signed_off_at         = CASE WHEN ${input.signedOffBy ?? null}::TEXT IS NOT NULL THEN now() ELSE signed_off_at END,
      version_history       = COALESCE(version_history, '[]'::JSONB) || CASE
        WHEN ${input.content ? JSON.stringify(input.content) : null}::JSONB IS NOT NULL
        THEN jsonb_build_array(jsonb_build_object(
          'version', (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(version_history, '[]'::JSONB))) + 1,
          'savedAt', now()::TEXT,
          'savedBy', COALESCE(${input.updatedBy ?? input.reviewedBy ?? input.signedOffBy ?? null}, 'system'),
          'content', ${input.content ? JSON.stringify(input.content) : null}::JSONB
        ))
        ELSE '[]'::JSONB
      END,
      updated_at            = now()
    WHERE id          = ${sectionId}::UUID
      AND document_id = ${documentId}::UUID
      AND company_id  = ${companyId}::UUID
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Section not found');
  }

  return rowToAfsSection(rows[0] as Record<string, unknown>);
}
