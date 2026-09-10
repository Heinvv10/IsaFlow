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
import { snapshotRenderInputs } from '@/modules/accounting/services/afs/afsSigningIntegrity';
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

  // 3. Fingerprint what is rendered. The company and brand inputs are read ONCE, in the same
  //     statement that fingerprints them, and the render uses those values instead of
  //     re-reading the tables — so the bytes Signum receives are, by construction, the bytes
  //     the fingerprint describes. No lock is taken on the company or its branding (edits to
  //     either are deliberately allowed while a document is out for signature); a later edit
  //     makes the webhook's recomputation differ and the signature is refused, naming it. The
  //     document and its sections are already held by the document lock above.
  //
  //     There is no stored artifact to sign: nothing in the product writes one, so reading a
  //     file here would post bytes of unknown provenance and arbitrary age.
  const snapshot = await snapshotRenderInputs(sql, companyId, documentId);
  let html: string;
  try {
    // skipChecks: the pre-export blocker gate is the export's own policy and runs there. What
    // matters here is that the bytes are DERIVED from the fingerprinted values; a render that
    // cannot be produced at all refuses the send.
    html = await renderDocumentHtml(documentId, companyId, {
      skipChecks: true,
      allowDefaultBrandProfile: true,
      inputs: {
        companyName: snapshot.companyName,
        registrationNumber: snapshot.registrationNumber,
        brandProfile: snapshot.brandProfile,
      },
    });
  } catch (err) {
    log.warn('Signing refused — the statements could not be rendered from the current content',
      { companyId, documentId, error: err instanceof Error ? err.message : String(err) }, 'send-for-signing-api');
    return apiResponse.conflict(
      res,
      `Cannot send for signing: the statements could not be rendered from the current content — ${err instanceof Error ? err.message : 'render failed'}`,
    );
  }
  const { fingerprint, digests } = snapshot;

  // 4. The document title carries the same company name the statements were rendered with
  const title = `Annual Financial Statements — ${snapshot.companyName}`;

  // 5. Send to Signum (JSON body — real API uses /documents/from-html)
  const signers = contacts.map((c) => ({ email: c.email, name: c.name }));
  // Both records: the inputs that were rendered (fingerprinted in the snapshot above), and the
  // exact bytes that were posted.
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
