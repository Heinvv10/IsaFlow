// src/modules/accounting/services/afs/afsProofCopyService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ProofCopyChecklist, ProofCopyChecklistItem } from './afsTypes';
import { SECTION_STATUS_ORDER } from './afsTypes';

// ── Internal helpers ────────────────────────────────────────────────────────

async function countMandatorySectionsBelowReviewed(
  companyId: string,
  documentId: string
): Promise<number> {
  const minOrder = SECTION_STATUS_ORDER.reviewed;
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_sections s
    LEFT JOIN note_templates nt ON nt.section_type = s.section_type
    WHERE s.document_id = ${documentId}
      AND s.company_id = ${companyId}
      AND (nt.is_mandatory = TRUE OR nt.id IS NULL)
      AND CASE s.status
            WHEN 'pending'        THEN 0
            WHEN 'auto_generated' THEN 1
            WHEN 'ai_enhanced'    THEN 2
            WHEN 'reviewed'       THEN 3
            WHEN 'signed_off'     THEN 4
          END < ${minOrder}
  `) as Record<string, unknown>[];
  const first = rows[0];
  return first !== undefined ? (first.cnt as number) ?? 0 : 0;
}

async function countUnresolvedCommentsForDocument(
  companyId: string,
  documentId: string
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_section_comments c
    JOIN afs_sections s ON s.id = c.section_id
    WHERE s.document_id = ${documentId}
      AND c.company_id = ${companyId}
      AND c.resolved = FALSE
  `) as Record<string, unknown>[];
  const first = rows[0];
  return first !== undefined ? (first.cnt as number) ?? 0 : 0;
}

async function getSectionStatusByType(
  companyId: string,
  documentId: string,
  sectionType: string
): Promise<string | null> {
  const rows = (await sql`
    SELECT status FROM afs_sections
    WHERE document_id = ${documentId}
      AND company_id = ${companyId}
      AND section_type = ${sectionType}
    LIMIT 1
  `) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const first = rows[0];
  return first !== undefined ? (first.status as string) : null;
}

async function hasComparativeFigures(
  companyId: string,
  documentId: string
): Promise<boolean> {
  const rows = (await sql`
    SELECT data_snapshot FROM afs_sections
    WHERE document_id = ${documentId}
      AND company_id = ${companyId}
      AND section_type = 'statement_of_fp'
    LIMIT 1
  `) as Record<string, unknown>[];
  if (rows.length === 0) return false;
  const first = rows[0];
  if (first === undefined) return false;
  const snapshot = first.data_snapshot;
  return snapshot !== null && typeof snapshot === 'object' && Object.keys(snapshot as object).length > 0;
}

async function hasRegistrationNumber(companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT registration_number FROM companies
    WHERE id = ${companyId}
  `) as Record<string, unknown>[];
  if (rows.length === 0) return false;
  const first = rows[0];
  if (first === undefined) return false;
  const regNum = first.registration_number;
  return typeof regNum === 'string' && regNum.trim().length > 0;
}

function isReviewedOrAbove(status: string | null): boolean {
  if (!status) return false;
  return SECTION_STATUS_ORDER[status as keyof typeof SECTION_STATUS_ORDER] >= SECTION_STATUS_ORDER.reviewed;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function getProofCopyChecklist(
  companyId: string,
  documentId: string
): Promise<ProofCopyChecklist> {
  // Verify document exists
  const docRows = (await sql`
    SELECT id FROM afs_documents
    WHERE id = ${documentId} AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  if (docRows.length === 0) {
    throw new Error(`AFS document ${documentId} not found`);
  }

  // Run automated checks in parallel
  const [
    mandatoryBelowCount,
    unresolvedCount,
    directorsStatus,
    auditorsStatus,
    hasComparatives,
    hasRegNum,
  ] = await Promise.all([
    countMandatorySectionsBelowReviewed(companyId, documentId),
    countUnresolvedCommentsForDocument(companyId, documentId),
    getSectionStatusByType(companyId, documentId, 'directors_report'),
    getSectionStatusByType(companyId, documentId, 'auditors_report'),
    hasComparativeFigures(companyId, documentId),
    hasRegistrationNumber(companyId),
  ]);

  const items: ProofCopyChecklistItem[] = [
    {
      key: 'all_mandatory_sections_reviewed',
      label: 'All mandatory sections reviewed or signed off',
      checked: mandatoryBelowCount === 0,
    },
    {
      key: 'no_unresolved_comments',
      label: 'No unresolved comments on any section',
      checked: unresolvedCount === 0,
    },
    {
      key: 'directors_report_reviewed',
      label: "Director's report section reviewed",
      checked: isReviewedOrAbove(directorsStatus),
    },
    {
      key: 'comparative_figures_present',
      label: 'Comparative figures present',
      checked: hasComparatives,
    },
    {
      key: 'registration_number_present',
      label: 'Company registration number correct',
      checked: hasRegNum,
    },
    {
      key: 'auditors_report_reviewed',
      label: "Auditor's report section reviewed",
      checked: isReviewedOrAbove(auditorsStatus),
    },
    // Manual items — always false, accountant must verify
    {
      key: 'note_cross_references_accurate',
      label: 'Note cross-references accurate',
      checked: false,
    },
    {
      key: 'page_numbers_sequential',
      label: 'Page numbers sequential',
      checked: false,
    },
    {
      key: 'toc_page_numbers_match',
      label: 'Table of contents page numbers match',
      checked: false,
    },
  ];

  const checklist: ProofCopyChecklist = {
    documentId,
    generatedAt: new Date().toISOString(),
    items,
    allPassed: items.every((i) => i.checked),
  };

  log.info('Proof copy checklist generated', {
    documentId, companyId, allPassed: checklist.allPassed,
  }, 'afsProofCopyService');

  return checklist;
}
