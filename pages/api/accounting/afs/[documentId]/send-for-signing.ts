// pages/api/accounting/afs/[documentId]/send-for-signing.ts — POST
// Auth: withAuth (staff-only)
// Reads rendered AFS HTML, calls Signum, sends per-signer notifications.

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { createHash } from 'crypto';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID, requireUuidParam } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { checkSendRateLimit } from '@/lib/rateLimit';
import { sendForSigning } from '@/modules/accounting/services/afs/signumIntegrationService';
import { countMandatorySectionsBelow, lockDocumentForTransition } from '@/modules/accounting/services/afs/afsDocumentTransitions';
import { documentContentFingerprint, lockRenderInputs } from '@/modules/accounting/services/afs/afsSigningIntegrity';
import { renderDocumentHtml } from '@/modules/accounting/services/afs/pdfExportService';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';
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

  const sendAllowed = await checkSendRateLimit(req, companyId, 'afs-signing');
  if (!sendAllowed) {
    return apiResponse.tooManyRequests(res, 'Too many send requests. Please try again later.');
  }

  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { signerContactIds } = parsed.data;

  // 1. Load and lock the document: from the moment the signing request is recorded the section
  //     write guard refuses every edit, so nothing may slip in between this check and that.
  let doc;
  try {
    doc = await lockDocumentForTransition(companyId, documentId);
  } catch (err) {
    if (sendReviewError(res, err, 'AFS document', documentId)) return;
    throw err;
  }

  if (doc.status !== 'partner_review') {
    return apiResponse.badRequest(
      res,
      'Document must be in partner_review status to send for signing',
    );
  }
  if (doc.signingRequestedAt) {
    return apiResponse.badRequest(res, 'Signing has already been requested for this document');
  }

  // What is signed must be what was reviewed and signed off, or the webhook would have to refuse
  // the signature when it arrives.
  const notSignedOff = await countMandatorySectionsBelow(companyId, documentId, 'signed_off');
  if (notSignedOff > 0) {
    return apiResponse.conflict(
      res,
      `Cannot send for signing: ${notSignedOff} mandatory section(s) not yet signed off`,
    );
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

  // 3. Render the statements from the CURRENT rows — the same rows the fingerprint is taken
  //     over. There is no stored artifact to sign: nothing in the product writes one, so
  //     reading a file here would post bytes of unknown provenance and arbitrary age.
  //
  //     The document row is already locked, and so are its sections (every section write takes
  //     FOR SHARE on the document). The company row and brand profile are held here for the
  //     same reason; the fingerprint is taken before AND after the render, which catches the one
  //     change a lock cannot stop — a first brand profile inserted while the render runs.
  try {
    await lockRenderInputs(sql, companyId);
  } catch (err) {
    if (sendReviewError(res, err, 'AFS document', documentId)) return;
    throw err;
  }
  const beforeRender = await documentContentFingerprint(sql, companyId, documentId);
  let html: string;
  try {
    // skipChecks: the pre-export blocker gate is the export's own policy and runs there. What
    // matters here is that the bytes are DERIVED from the current rows rather than read from a
    // stored artifact; a render that cannot be produced at all refuses the send.
    html = await renderDocumentHtml(documentId, companyId, { skipChecks: true, allowDefaultBrandProfile: true });
  } catch (err) {
    log.warn('Signing refused — the statements could not be rendered from the current content',
      { companyId, documentId, error: err instanceof Error ? err.message : String(err) }, 'send-for-signing-api');
    return apiResponse.conflict(
      res,
      `Cannot send for signing: the statements could not be rendered from the current content — ${err instanceof Error ? err.message : 'render failed'}`,
    );
  }
  const { fingerprint, digests } = await documentContentFingerprint(sql, companyId, documentId);
  if (fingerprint !== beforeRender.fingerprint) {
    log.warn('Signing refused — an input changed while the statements were rendering', { companyId, documentId }, 'send-for-signing-api');
    return apiResponse.conflict(
      res,
      'Cannot send for signing: the company settings or branding changed while the statements were being prepared — send it for signature again',
    );
  }

  // 4. Load company name for document title
  const companies = (await sql`
    SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  `) as Array<{ name: string }>;
  const companyName = companies.length > 0 ? companies[0]!.name : 'Company';
  const title = `Annual Financial Statements — ${companyName}`;

  // 5. Send to Signum (JSON body — real API uses /documents/from-html)
  const signers = contacts.map((c) => ({ email: c.email, name: c.name }));
  // Both records: the rows that were rendered (taken above, unchanged across the render), and
  // the exact bytes that were posted.
  const payloadSha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  const { signumDocumentId, signingTokens } = await sendForSigning(
    documentId,
    companyId,
    html,
    title,
    signers,
    { contentFingerprint: fingerprint, inputDigests: digests, payloadSha256 },
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
