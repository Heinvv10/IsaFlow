// pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { generateNoteNarrative, type CompanyContext } from '@/modules/accounting/services/afs/noteAiService';
import type { NoteContent, ReportingFramework, SectionType } from '@/modules/accounting/services/afs/afsTypes';
import type { DbRow } from '@/types/db';

// ── POST — generate AI narrative ─────────────────────────────────────────────

async function handleGenerate(
  _req: NextApiRequest,
  res: NextApiResponse,
  companyId: string,
  documentId: string,
  sectionId: string,
): Promise<void> {
  log.info('Generating AI narrative', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');

  const rows = await sql`
    SELECT s.section_type, s.content,
           c.name AS company_name,
           d.framework, d.fiscal_year,
           nt.ai_prompt_template
    FROM afs_sections s
    JOIN afs_documents d ON d.id = s.document_id AND d.company_id = ${companyId}::UUID
    JOIN companies c ON c.id = d.company_id
    LEFT JOIN note_templates nt ON nt.section_type = s.section_type
    WHERE s.id = ${sectionId}::UUID
      AND s.document_id = ${documentId}::UUID
    LIMIT 1
  `;

  const row = rows[0] as DbRow | undefined;
  if (!row) {
    apiResponse.notFound(res, 'Section not found');
    return;
  }

  const aiPromptTemplate = row.ai_prompt_template as string | null;
  if (!aiPromptTemplate) {
    apiResponse.badRequest(res, 'No AI prompt template configured for this section type');
    return;
  }

  const companyContext: CompanyContext = {
    name: row.company_name as string,
    framework: row.framework as ReportingFramework,
    fiscalYear: row.fiscal_year as number,
  };

  const narrative = await generateNoteNarrative(
    row.section_type as SectionType,
    row.content as NoteContent,
    aiPromptTemplate,
    companyContext,
  );

  await sql`
    UPDATE afs_sections
    SET ai_narrative = ${narrative},
        ai_enhanced  = false,
        updated_at   = NOW()
    WHERE id = ${sectionId}::UUID
      AND document_id IN (
        SELECT id FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
      )
  `;

  log.info('AI narrative generated and saved', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');
  apiResponse.success(res, { narrative });
}

// ── PUT — accept AI narrative ────────────────────────────────────────────────

async function handleAccept(
  _req: NextApiRequest,
  res: NextApiResponse,
  companyId: string,
  documentId: string,
  sectionId: string,
): Promise<void> {
  log.info('Accepting AI narrative', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');

  const rows = await sql`
    SELECT s.ai_narrative, s.content
    FROM afs_sections s
    WHERE s.id = ${sectionId}::UUID
      AND s.document_id IN (
        SELECT id FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
      )
    LIMIT 1
  `;

  const row = rows[0] as DbRow | undefined;
  if (!row) {
    apiResponse.notFound(res, 'Section not found');
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

  await sql`
    UPDATE afs_sections
    SET ai_narrative_accepted = true,
        overrides = ${JSON.stringify(mergedContent)}::JSONB,
        updated_at = NOW()
    WHERE id = ${sectionId}::UUID
      AND document_id IN (
        SELECT id FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
      )
  `;

  log.info('AI narrative accepted', { companyId, documentId, sectionId }, 'afs-ai-narrative-api');
  apiResponse.success(res, { accepted: true });
}

// ── Router ───────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const { documentId, sectionId } = req.query as { documentId: string; sectionId: string };

  if (req.method === 'POST') {
    // LLM-backed — rate-limit per tenant AND per IP to bound Anthropic spend.
    if (!(await checkRateLimit(`afs-ai:company:${companyId}`, { max: 20, windowSecs: 3600 }))) {
      return apiResponse.tooManyRequests(res);
    }
    if (!(await checkRateLimit(`afs-ai:ip:${getClientIp(req)}`, { max: 30, windowSecs: 3600 }))) {
      return apiResponse.tooManyRequests(res);
    }
    return handleGenerate(req, res, companyId, documentId, sectionId);
  }
  if (req.method === 'PUT') {
    return handleAccept(req, res, companyId, documentId, sectionId);
  }
  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
