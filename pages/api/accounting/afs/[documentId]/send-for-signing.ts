// pages/api/accounting/afs/[documentId]/send-for-signing.ts — POST
// Auth: withAuth (staff-only)
// Reads rendered AFS HTML, calls Signum, sends per-signer notifications.

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import fs from 'fs/promises';
import { withErrorHandler } from '@/lib/api-error-handler';
import { afsHtmlPath } from '@/lib/storage/afsStorage';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { sendForSigning } from '@/modules/accounting/services/afs/signumIntegrationService';
import { notifySigningRequested } from '@/modules/accounting/services/afs/portalNotificationService';
import type { PortalRole } from '@/modules/accounting/services/afs/afsTypes';

const SIGNER_ROLES: PortalRole[] = ['director', 'cfo'];

const BodySchema = z.object({
  signerContactIds: z.array(UUID).min(1).max(20),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const docParse = UUID.safeParse(req.query.documentId);
  if (!docParse.success) return apiResponse.badRequest(res, 'documentId must be a valid UUID');
  const documentId = docParse.data;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { signerContactIds } = parsed.data;

  // 1. Load and verify the document
  const docs = (await sql`
    SELECT id, status, signing_requested_at
    FROM afs_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Array<{ id: string; status: string; signing_requested_at: Date | null }>;

  if (docs.length === 0) return apiResponse.notFound(res, 'AFS document', documentId);

  const doc = docs[0]!;
  if (doc.status !== 'partner_review') {
    return apiResponse.badRequest(
      res,
      'Document must be in partner_review status to send for signing',
    );
  }
  if (doc.signing_requested_at) {
    return apiResponse.badRequest(res, 'Signing has already been requested for this document');
  }

  // 2. Load and verify signer contacts (IDOR guard: must belong to this company)
  const contacts = (await sql`
    SELECT id, name, email, role
    FROM portal_contacts
    WHERE id = ANY(${signerContactIds}::UUID[])
      AND company_id = ${companyId}::UUID
      AND active = true
  `) as Array<{ id: string; name: string; email: string; role: string }>;

  if (contacts.length !== signerContactIds.length) {
    return apiResponse.badRequest(res, 'One or more signer contacts not found or inactive');
  }

  for (const c of contacts) {
    if (!SIGNER_ROLES.includes(c.role as PortalRole)) {
      return apiResponse.badRequest(
        res,
        `Contact ${c.name} has role '${c.role}' — only directors and CFOs can sign`,
      );
    }
  }

  // 3. Load rendered AFS HTML (stored by render service)
  const htmlPath = afsHtmlPath(companyId, documentId);
  let html: string;
  try {
    html = await fs.readFile(htmlPath, 'utf-8');
  } catch {
    return apiResponse.badRequest(res, 'Rendered HTML not yet generated for this document');
  }

  // 4. Load company name for document title
  const companies = (await sql`
    SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  `) as Array<{ name: string }>;
  const companyName = companies.length > 0 ? companies[0]!.name : 'Company';
  const title = `Annual Financial Statements — ${companyName}`;

  // 5. Send to Signum (JSON body — real API uses /documents/from-html)
  const signers = contacts.map((c) => ({ email: c.email, name: c.name }));
  const { signumDocumentId, signingTokens } = await sendForSigning(
    documentId,
    companyId,
    html,
    title,
    signers,
  );

  // 6. Notify each signer with their individual signing URL
  const callbackBaseUrl =
    process.env.SIGNUM_CALLBACK_BASE_URL ?? 'https://app.isaflow.co.za/accounting/afs/sign';
  for (const c of contacts) {
    const signerToken = signingTokens.find((t) => t.email === c.email);
    const signingUrl = signerToken
      ? `${callbackBaseUrl}/${signerToken.signingToken}`
      : callbackBaseUrl;
    await notifySigningRequested(
      {
        id: c.id,
        companyId,
        name: c.name,
        email: c.email,
        role: c.role as PortalRole,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      documentId,
      signingUrl,
    );
  }

  log.info(
    'Document sent for signing',
    { documentId, signumDocumentId, signerCount: signers.length },
    'send-for-signing-api',
  );
  return apiResponse.success(res, {
    signumDocumentId,
    signingTokens,
    message: 'Signing requests sent',
  });
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
