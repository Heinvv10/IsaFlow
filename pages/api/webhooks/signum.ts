// pages/api/webhooks/signum.ts — POST
// Auth: NONE (webhook). Secured by HMAC-SHA256 signature verification.
// bodyParser: false — raw body required for signature verification.

import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import { afsQuarantinedPdfPath, afsSignedPdfPath } from '@/lib/storage/afsStorage';
import {
  verifySignumWebhookSignature,
  downloadSignedPdf,
} from '@/modules/accounting/services/afs/signumIntegrationService';
import { notifyDocumentSignedOff } from '@/modules/accounting/services/afs/portalNotificationService';
import { recordSignatureRefusal, signatureRefusalReason } from '@/modules/accounting/services/afs/afsSigningIntegrity';

export const config = { api: { bodyParser: false } };

function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const KNOWN_EVENTS = [
  'document.signed',
  'document.declined',
  'document.cancelled',
  'document.expired',
] as const;

interface SignumWebhookPayload {
  documentId: string;
  event: string;
  signedAt?: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Read raw body for HMAC verification
  const rawBody = await readRawBody(req);
  const signatureHeader = req.headers['x-signum-signature'];

  if (typeof signatureHeader !== 'string') {
    log.warn('Signum webhook: missing X-Signum-Signature header', {}, 'signum-webhook');
    return res.status(401).json({ error: 'Missing signature' });
  }

  if (!verifySignumWebhookSignature(rawBody, signatureHeader)) {
    log.warn('Signum webhook HMAC verification failed', {}, 'signum-webhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Parse payload
  const payload = JSON.parse(rawBody) as SignumWebhookPayload;

  if (!KNOWN_EVENTS.includes(payload.event as (typeof KNOWN_EVENTS)[number])) {
    log.info(
      'Signum webhook: unrecognised event — acknowledging',
      { event: payload.event },
      'signum-webhook',
    );
    return res.status(200).json({ received: true });
  }

  // 3. Look up afs_document by signum_document_id (includes status for idempotency guard)
  const rows = (await sql`
    SELECT id, company_id, status FROM afs_documents
    WHERE signum_document_id = ${payload.documentId}
    LIMIT 1
  `) as Array<{ id: string; company_id: string; status: string }>;

  if (rows.length === 0) {
    log.warn(
      'Signum webhook: no afs_document found for signum_document_id',
      { signumDocumentId: payload.documentId, event: payload.event },
      'signum-webhook',
    );
    return res.status(200).json({ received: true }); // don't retry
  }

  const doc = rows[0]!;

  // 3a. Only a document still awaiting its signature moves. A signed-off document has already
  //     been through this (replay), and a filed one must never travel backwards.
  if (doc.status !== 'partner_review') {
    log.info(
      'Signum webhook ignored — the document is no longer awaiting signature',
      { documentId: doc.id, status: doc.status, event: payload.event },
      'signum-webhook',
    );
    return res.status(200).json({ received: true });
  }

  // 4. Handle non-signed terminal events — reset signing state so staff can resend
  if (payload.event !== 'document.signed') {
    await sql`
      UPDATE afs_documents
      SET signum_document_id          = NULL,
          signing_requested_at        = NULL,
          signing_content_fingerprint = NULL,
          updated_at                  = now()
      WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
        AND status = 'partner_review'
    `;
    log.info(
      'Signum signing terminal event — signing state reset',
      { documentId: doc.id, event: payload.event },
      'signum-webhook',
    );
    return res.status(200).json({ received: true });
  }

  // 5. Sign off only the content that was sent. The document row is locked first, so the check
  //    and the sign-off are one decision, and the section write guard (which refuses every edit
  //    while signing_requested_at is set) cannot be raced by an edit that started earlier.
  const outcome = await withTransaction(async (tx) => {
    // A wedged peer must surface as a failed delivery Signum retries, not a pinned connection.
    await tx`SET LOCAL lock_timeout = '5s'`;
    const locked = (await tx`
      SELECT status, signing_content_fingerprint
      FROM afs_documents
      WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
      FOR UPDATE
    `) as Array<{ status: string; signing_content_fingerprint: string | null }>;
    const row = locked[0];
    if (!row || row.status !== 'partner_review') return { signed: false as const, reason: null };

    const refusal = await signatureRefusalReason(tx, doc.company_id, doc.id, row.signing_content_fingerprint);
    if (refusal) {
      // The signatories DID sign, so the artifact is kept as evidence — in quarantine, never as
      // the document's signed copy. Signum's API as integrated here has no void/cancel call, so
      // a person must cancel the request at the provider; the recorded reason says so.
      const quarantine = afsQuarantinedPdfPath(doc.company_id, doc.id, new Date().toISOString().replace(/[:.]/g, '-'));
      try {
        const refusedPdf = await downloadSignedPdf(payload.documentId);
        await fs.mkdir(path.dirname(quarantine), { recursive: true });
        await fs.writeFile(quarantine, refusedPdf);
      } catch (err) {
        log.error('Refused signature could not be quarantined', {
          documentId: doc.id, error: err instanceof Error ? err.message : String(err),
        }, 'signum-webhook');
      }
      await recordSignatureRefusal(tx, doc.company_id, doc.id,
        `${refusal}. The signed copy is quarantined at ${quarantine}; cancel the request at Signum before sending again.`);
      return { signed: false as const, reason: refusal };
    }

    // Download and store the signed PDF only once the signature is going to be accepted.
    const pdfBuffer = await downloadSignedPdf(payload.documentId);
    const storagePath = afsSignedPdfPath(doc.company_id, doc.id);
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, pdfBuffer);

    await tx`
      UPDATE afs_documents
      SET status          = 'signed_off',
          locked_at       = now(),
          signed_pdf_path = ${storagePath},
          updated_at      = now()
      WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
        AND status = 'partner_review'
    `;
    return { signed: true as const, reason: null };
  });

  if (!outcome.signed) {
    return res.status(200).json({ received: true, ...(outcome.reason ? { refused: outcome.reason } : {}) });
  }

  // 6. Notify portal contacts
  await notifyDocumentSignedOff(doc.company_id, doc.id);

  log.info(
    'Document signed off via Signum webhook',
    { documentId: doc.id, signumDocumentId: payload.documentId },
    'signum-webhook',
  );
  return res.status(200).json({ received: true });
}

export default withErrorHandler(handler as never);
