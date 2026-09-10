// src/modules/accounting/services/afs/noteEngineService.ts
// 4-stage pipeline orchestrator: fetch → generate → suppress → persist

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isZeroBalance } from './noteDataQueryService';
import { NOTE_GENERATOR_MAP } from './noteGenerators';
import { lockSectionForWrite, voidSectionAttestation } from './afsSectionAttestation';
import type { SectionType, ReportingFramework } from './afsTypes';

// ── Internal row shapes ───────────────────────────────────────────────────────

interface SectionRow {
  section_type: string;
  status: string;
  is_mandatory: boolean;
  ai_prompt_template: string | null;
}

interface SectionListRow {
  id: string;
  section_type: string;
}

// ── generateSection ───────────────────────────────────────────────────────────

/**
 * Runs the 4-stage pipeline for a single AFS section:
 *   1. Fetch section + template metadata
 *   2. Run note generator
 *   3. Auto-suppress if zero-balance + non-mandatory
 *   4. Persist rendered content (status = 'auto_generated')
 *   5. Log AI narrative intent (afs_generation_log lacks section_id/job_type)
 */
export async function generateSection(
  companyId: string,
  documentId: string,
  sectionId: string,
  fiscalYear: number,
  framework: ReportingFramework,
  userId: string,
): Promise<void> {
  // ── Stage 0: The write guard, like every other section writer ─────────────
  // Generated content replaces whatever was there, so it is bound to the document in the
  // request, refused while that document is locked or out for signature, and it voids the
  // review the old content carried.
  //
  // The guard is only as strong as the caller's transaction. Called from a request (the
  // regenerate route) the lock is held to COMMIT. Called from a worker or a script with no
  // request context, SET LOCAL lock_timeout no-ops and FOR UPDATE releases at the end of its
  // own statement, so the check below becomes advisory — a check-then-act window that a
  // concurrent sign-off can slip through. Any worker that drives this must open its own
  // transaction (als.run with a client, as the audit poller does) before calling it.
  const locked = await lockSectionForWrite(companyId, documentId, sectionId);
  await voidSectionAttestation(companyId, locked, userId, 'Section regenerated from the ledger');

  // ── Stage 1: Fetch section + template ─────────────────────────────────────
  const rows = (await sql`
    SELECT
      s.section_type,
      s.status,
      COALESCE(nt.is_mandatory, false) AS is_mandatory,
      nt.ai_prompt_template
    FROM afs_sections s
    LEFT JOIN note_templates nt ON nt.section_type = s.section_type
    WHERE s.id           = ${sectionId}::UUID
      AND s.document_id  = ${documentId}::UUID
      AND s.company_id   = ${companyId}::UUID
    LIMIT 1
  `) as SectionRow[];

  if (rows.length === 0) {
    throw new Error('Section not found or access denied');
  }

  const row0 = rows[0] as SectionRow;
  const { section_type: sectionType, is_mandatory: isMandatory, ai_prompt_template: aiPromptTemplate } = row0;

  log.info('Generating AFS section', { companyId, documentId, sectionId, sectionType }, 'noteEngineService');

  // ── Stage 2: Run note generator ───────────────────────────────────────────
  const generator = NOTE_GENERATOR_MAP[sectionType as SectionType];
  if (!generator) {
    throw new Error(`No generator for section type: ${sectionType}`);
  }

  const { dataSnapshot, content } = await generator(companyId, fiscalYear, framework);

  // ── Stage 3: Auto-suppress zero-balance non-mandatory sections ────────────
  if (isZeroBalance(dataSnapshot) && !isMandatory) {
    await sql`
      UPDATE afs_sections
      SET
        data_snapshot = ${JSON.stringify({ ...dataSnapshot, suppressReason: 'zero_balance' })}::JSONB,
        status        = 'pending',
        updated_at    = NOW()
      WHERE id          = ${sectionId}::UUID
        AND document_id = ${documentId}::UUID
        AND company_id  = ${companyId}::UUID
    `;
    log.info('Section suppressed (zero balance)', { companyId, sectionId, sectionType }, 'noteEngineService');
    return;
  }

  // ── Stage 4: Persist rendered content ─────────────────────────────────────
  await sql`
    UPDATE afs_sections
    SET
      data_snapshot = ${JSON.stringify(dataSnapshot)}::JSONB,
      content       = ${JSON.stringify(content)}::JSONB,
      status        = 'auto_generated',
      updated_at    = NOW()
    WHERE id          = ${sectionId}::UUID
      AND document_id = ${documentId}::UUID
      AND company_id  = ${companyId}::UUID
  `;

  // ── Stage 5: Enqueue AI narrative ─────────────────────────────────────────
  // afs_generation_log lacks section_id and job_type columns (migration 336).
  // Log intent only — a future migration will add the columns.
  if (aiPromptTemplate) {
    log.info(
      'AI narrative enqueued (no section_id column — logged only)',
      { companyId, documentId, sectionId, sectionType },
      'noteEngineService',
    );
  }
}

// ── generateAllSections ───────────────────────────────────────────────────────

/**
 * Generates all sections in a document concurrently (ordered by sort_order).
 * Individual section failures are caught and logged so other sections continue unaffected —
 * and RETURNED, so the caller can surface a refusal rather than lose it.
 */
export async function generateAllSections(
  companyId: string,
  documentId: string,
  fiscalYear: number,
  framework: ReportingFramework,
  userId: string,
): Promise<Array<{ sectionId: string; error: string }>> {
  // Failures are returned, not only logged: a refusal from the write guard (a locked document,
  // a section of another document) is an answer the caller has to act on, and a log line is
  // not an answer.
  const failures: Array<{ sectionId: string; error: string }> = [];
  const sections = (await sql`
    SELECT s.id, s.section_type
    FROM afs_sections s
    WHERE s.document_id = ${documentId}::UUID
      AND s.company_id  = ${companyId}::UUID
      AND s.document_id IN (
        SELECT id FROM afs_documents
        WHERE id         = ${documentId}::UUID
          AND company_id = ${companyId}::UUID
      )
    ORDER BY s.sort_order ASC
  `) as SectionListRow[];

  await Promise.all(
    sections.map(async (s) => {
      try {
        await generateSection(
          companyId,
          documentId,
          s.id,
          fiscalYear,
          framework,
          userId,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          'Section generation failed',
          { companyId, documentId, sectionId: s.id, error: message },
          'noteEngineService',
        );
        failures.push({ sectionId: s.id, error: message });
      }
    }),
  );

  return failures;
}
