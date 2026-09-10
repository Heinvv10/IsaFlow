// pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { requireUuidParam } from '@/lib/schemas/common';
import { checkAiRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { generateNoteNarrative, type CompanyContext } from '@/modules/accounting/services/afs/noteAiService';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';
import {
  lockSectionForWrite,
  voidSectionAttestation,
  type LockedSection,
} from '@/modules/accounting/services/afs/afsSectionAttestation';
import type { NoteContent, ReportingFramework, SectionType } from '@/modules/accounting/services/afs/afsTypes';
import type { DbRow } from '@/types/db';

/**
 * Both handlers write the section, so both bind it to the URL's document and refuse a
 * signed-off, filed or out-for-signature one. Null means the refusal has already been sent.
 */
async function lockOrRefuse(
  res: NextApiResponse,
  companyId: string,
  documentId: string,
  sectionId: string,
): Promise<LockedSection | null> {
  try {
    return await lockSectionForWrite(companyId, documentId, sectionId);
  } catch (err) {
    if (sendReviewError(res, err, 'Section', sectionId)) return null;
    throw err;
  }
}

// ── POST — generate AI narrative ─────────────────────────────────────────────

async function handleGenerate(
  req: NextApiRequest,
  res: NextApiResponse,
  companyId: string,
  userId: string,
  documentId: string,
  sectionId: string,
): Promise<void> {
  log.info('Generating AI narrative', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');

  // Read bound to this document but WITHOUT a lock: the model call that follows can take
  // minutes, and a row lock held across it would stall every other write to the document — and
  // the sign-off, submission and promotion that wait on its row — while holding a pool
  // connection. The lock is taken afterwards, and the content re-checked under it.
  const rows = await sql`
    SELECT s.section_type, s.content, s.overrides, s.ai_narrative_accepted,
           c.name AS company_name,
           d.reporting_framework AS framework, d.fiscal_year, d.status AS document_status,
           d.signing_requested_at,
           nt.ai_prompt_template
    FROM afs_sections s
    JOIN afs_documents d ON d.id = s.document_id AND d.company_id = ${companyId}::UUID
    JOIN companies c ON c.id = d.company_id
    LEFT JOIN note_templates nt
      ON nt.section_type = s.section_type
     AND nt.framework IN (d.reporting_framework, 'both')
    WHERE s.id = ${sectionId}::UUID
      AND s.document_id = ${documentId}::UUID
      AND s.company_id = ${companyId}::UUID
    ORDER BY (nt.framework = d.reporting_framework) DESC NULLS LAST
    LIMIT 1
  `;

  const row = rows[0] as DbRow | undefined;
  if (!row) {
    apiResponse.notFound(res, 'Section', sectionId);
    return;
  }
  // Refused BEFORE the rate limiter and the model call: a locked document must not spend
  // model budget to be told no.
  if (row.document_status === 'signed_off' || row.document_status === 'filed') {
    apiResponse.conflict(res, 'Document is locked — no edits allowed');
    return;
  }
  if (row.signing_requested_at != null) {
    apiResponse.conflict(res, 'Document is out for signature — no edits until signing completes');
    return;
  }

  const aiPromptTemplate = row.ai_prompt_template as string | null;
  if (!aiPromptTemplate) {
    apiResponse.badRequest(res, 'No AI prompt template configured for this section type');
    return;
  }

  // Sonnet-backed (pricier) — per-IP + per-company + per-company-daily budget cap (pentest H8).
  if (!(await checkAiRateLimit(req, companyId, 'afs-ai-narrative', { ipMax: 30, companyMax: 20, dailyMax: 100 }))) {
    apiResponse.tooManyRequests(res, 'AI request limit reached. Please try again later.');
    return;
  }

  const contentAtRead = (row.content as NoteContent | null) ?? null;
  // Everything the statements or the portal render from, not only `content`: an accepted
  // narrative writes `overrides`, which is what is printed when it is there.
  const renderedAtRead = JSON.stringify([row.content ?? null, row.overrides ?? null, Boolean(row.ai_narrative_accepted)]);
  const companyContext: CompanyContext = {
    name: row.company_name as string,
    framework: row.framework as ReportingFramework,
    fiscalYear: row.fiscal_year as number,
  };

  const narrative = await generateNoteNarrative(
    row.section_type as SectionType,
    contentAtRead ?? { title: '', blocks: [] },
    aiPromptTemplate,
    companyContext,
  );

  const section = await lockOrRefuse(res, companyId, documentId, sectionId);
  if (!section) return;

  // Re-checked under the lock: a narrative written about content that has since changed would
  // describe figures the section no longer holds.
  const current = (await sql`
    SELECT content, overrides, ai_narrative_accepted FROM afs_sections
    WHERE id = ${sectionId}::UUID AND document_id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `)[0] as DbRow | undefined;
  const renderedNow = JSON.stringify([current?.content ?? null, current?.overrides ?? null, Boolean(current?.ai_narrative_accepted)]);
  if (renderedNow !== renderedAtRead) {
    apiResponse.conflict(res, 'Section content changed while the narrative was being generated — regenerate it');
    return;
  }

  try {
    // The narrative and its accepted flag are content: they are in the signing fingerprint, the
    // portal prints the narrative where a section has no blocks, and updateAfsSection voids on
    // either. So generating one voids the review the old state carried.
    await voidSectionAttestation(companyId, section, userId, 'AI narrative generated for the section');
  } catch (err) {
    if (sendReviewError(res, err, 'Section', sectionId)) return;
    throw err;
  }

  await sql`
    UPDATE afs_sections
    SET ai_narrative = ${narrative},
        ai_narrative_accepted = false,
        updated_at   = NOW()
    WHERE id = ${sectionId}::UUID
      AND document_id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
  `;

  log.info('AI narrative generated and saved', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');
  apiResponse.success(res, { narrative });
}

// ── PUT — accept AI narrative ────────────────────────────────────────────────

async function handleAccept(
  _req: NextApiRequest,
  res: NextApiResponse,
  companyId: string,
  userId: string,
  documentId: string,
  sectionId: string,
): Promise<void> {
  log.info('Accepting AI narrative', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');
  const section = await lockOrRefuse(res, companyId, documentId, sectionId);
  if (!section) return;

  const rows = await sql`
    SELECT s.ai_narrative, s.content
    FROM afs_sections s
    WHERE s.id = ${sectionId}::UUID
      AND s.document_id = ${documentId}::UUID
      AND s.company_id = ${companyId}::UUID
    LIMIT 1
  `;

  const row = rows[0] as DbRow | undefined;
  if (!row) {
    apiResponse.notFound(res, 'Section', sectionId);
    return;
  }

  const aiNarrative = row.ai_narrative as string | null;
  if (!aiNarrative) {
    apiResponse.badRequest(res, 'No AI narrative to accept');
    return;
  }

  const currentContent = row.content as NoteContent | null;
  const mergedBlocks = [
    ...(currentContent?.blocks ?? []),
    { type: 'paragraph' as const, text: aiNarrative },
  ];
  const mergedContent: NoteContent = {
    title: currentContent?.title ?? '',
    blocks: mergedBlocks,
  };

  try {
    // Accepting replaces the rendered content, so the review of the old content is void.
    await voidSectionAttestation(companyId, section, userId, 'AI narrative accepted into the section');
  } catch (err) {
    if (sendReviewError(res, err, 'Section', sectionId)) return;
    throw err;
  }

  await sql`
    UPDATE afs_sections
    SET ai_narrative_accepted = true,
        overrides = ${JSON.stringify(mergedContent)}::JSONB,
        updated_at = NOW()
    WHERE id = ${sectionId}::UUID
      AND document_id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
  `;

  log.info('AI narrative accepted', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');
  apiResponse.success(res, { accepted: true });
}

// ── Router ───────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;
  const sectionId = requireUuidParam(req, res, 'sectionId');
  if (!sectionId) return;

  if (req.method === 'POST') {
    return handleGenerate(req, res, companyId, userId, documentId, sectionId);
  }
  if (req.method === 'PUT') {
    return handleAccept(req, res, companyId, userId, documentId, sectionId);
  }
  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
