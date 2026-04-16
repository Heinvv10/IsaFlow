// src/modules/accounting/services/afs/noteEngineService.ts
// 4-stage pipeline orchestrator: fetch → generate → suppress → persist

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isZeroBalance } from './noteDataQueryService';
import { NOTE_GENERATOR_MAP } from './noteGenerators';
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
): Promise<void> {
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
 * Individual section failures are caught, logged, and swallowed so other
 * sections continue unaffected.
 */
export async function generateAllSections(
  companyId: string,
  documentId: string,
  fiscalYear: number,
  framework: ReportingFramework,
): Promise<void> {
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
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          'Section generation failed',
          { companyId, documentId, sectionId: s.id, error: message },
          'noteEngineService',
        );
      }
    }),
  );
}
