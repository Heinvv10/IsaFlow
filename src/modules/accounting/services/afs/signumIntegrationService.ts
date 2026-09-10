/**
 * Signum Integration Service
 * Calls the real Signum API to create signing documents, verify webhook signatures,
 * and download signed PDFs.
 *
 * Prerequisite (one-time manual): Register the webhook in the Signum admin console:
 *   URL: https://app.isaflow.co.za/api/webhooks/signum
 *   Events: document.signed, document.declined, document.cancelled, document.expired
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { SigningInputDigests } from './afsSigningIntegrity';

// ── Types ────────────────────────────────────────────────────────────────────

interface SignumApiResponse {
  documentId: string;
  signers: Array<{ email: string; signingToken: string }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Send an AFS document for signing via the Signum API.
 *
 * Posts rendered HTML to POST /documents/from-html.
 * Stores signumDocumentId + signing_requested_at + the content fingerprint on the afs_document
 * record: from here on the section write guard refuses every edit to the document, and the
 * webhook signs it off only while that fingerprint still holds.
 * Status stays 'partner_review' — the webhook moves it to 'signed_off'.
 */
export async function sendForSigning(
  documentId: string,
  companyId: string,
  html: string,
  title: string,
  signers: Array<{ email: string; name: string }>,
  // contentFingerprint is the CONTROL the webhook enforces. payloadSha256 is EVIDENCE only:
  // the provider returns a signed, annotated PDF, which can never byte-match the HTML posted
  // here, so nothing can verify one against the other. It records what left this system.
  evidence: { contentFingerprint: string; inputDigests: SigningInputDigests; payloadSha256: string },
): Promise<{ signumDocumentId: string; signingTokens: Array<{ email: string; signingToken: string }> }> {
  const apiUrl = getRequiredEnv('SIGNUM_API_URL');
  const apiKey = getRequiredEnv('SIGNUM_API_KEY');
  const callbackBaseUrl = getRequiredEnv('SIGNUM_CALLBACK_BASE_URL');
  const expiresInDays = Number(process.env.SIGNUM_EXPIRES_IN_DAYS ?? 14);

  const res = await fetch(`${apiUrl}/documents/from-html`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html,
      title,
      senderEmail: 'accounts@isaflow.co.za',
      signers,
      callbackBaseUrl,
      expiresInDays,
    }),
    // The request holds the document's row lock while this runs.
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Signum create failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as SignumApiResponse;

  // Store signumDocumentId + signing_requested_at + fingerprint — status stays 'partner_review'
  await sql`
    UPDATE afs_documents
    SET signum_document_id          = ${json.documentId},
        signing_requested_at        = now(),
        signing_content_fingerprint = ${evidence.contentFingerprint},
        signing_input_digests       = ${JSON.stringify(evidence.inputDigests)}::jsonb,
        signing_payload_sha256      = ${evidence.payloadSha256},
        signing_refused_at          = NULL,
        signing_refused_reason      = NULL,
        updated_at                  = now()
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info(
    'Signum document created',
    { documentId, signumDocumentId: json.documentId, signerCount: signers.length, payloadSha256: evidence.payloadSha256 },
    'signumIntegrationService',
  );

  return { signumDocumentId: json.documentId, signingTokens: json.signers };
}

/**
 * Verify the HMAC signature on a Signum webhook request.
 *
 * Header format: X-Signum-Signature: sha256=<hex>
 * Uses timingSafeEqual to prevent timing attacks. Returns false on length mismatch.
 */
export function verifySignumWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.SIGNUM_WEBHOOK_SECRET;
  if (!secret) throw new Error('SIGNUM_WEBHOOK_SECRET not configured');
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice(7); // strip 'sha256='

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    // timingSafeEqual throws if buffers have different lengths (tampered header)
    return false;
  }
}

/**
 * Download the signed PDF from Signum after a document.signed webhook.
 *
 * TODO: Confirm with Signum whether GET /documents/{id}/download is the correct endpoint,
 * or whether the signed PDF URL is embedded in the document.signed webhook payload.
 * If the latter, replace this function with a direct fetch to the payload URL.
 */
export async function downloadSignedPdf(signumDocumentId: string): Promise<Buffer> {
  const apiUrl = getRequiredEnv('SIGNUM_API_URL');
  const apiKey = getRequiredEnv('SIGNUM_API_KEY');

  const res = await fetch(`${apiUrl}/documents/${signumDocumentId}/download`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Signum download failed: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  log.info('Signed PDF downloaded', { signumDocumentId }, 'signumIntegrationService');
  return Buffer.from(arrayBuffer);
}
