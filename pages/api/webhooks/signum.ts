// pages/api/webhooks/signum.ts — POST
// Auth: NONE (webhook). Secured by HMAC-SHA256 signature verification.
// bodyParser: false — raw body required for signature verification.

import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  verifySignumWebhookSignature,
  downloadSignedPdf,
} from '@/modules/accounting/services/afs/signumIntegrationService';
import { notifyDocumentSignedOff } from '@/modules/accounting/services/afs/portalNotificationService';

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

  // 3. Look up afs_document by signum_document_id
  const rows = (await sql`
    SELECT id, company_id FROM afs_documents
    WHERE signum_document_id = ${payload.documentId}
    LIMIT 1
  `) as Array<{ id: string; company_id: string }>;

  if (rows.length === 0) {
    log.warn(
      'Signum webhook: no afs_document found for signum_document_id',
      { signumDocumentId: payload.documentId, event: payload.event },
      'signum-webhook',
    );
    return res.status(200).json({ received: true }); // don't retry
  }

  const doc = rows[0]!;

  // 4. Handle non-signed terminal events — reset signing state so staff can resend
  if (payload.event !== 'document.signed') {
    await sql`
      UPDATE afs_documents
      SET signum_document_id  = NULL,
          signing_requested_at = NULL,
          updated_at           = now()
      WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
    `;
    log.info(
      'Signum signing terminal event — signing state reset',
      { documentId: doc.id, event: payload.event },
      'signum-webhook',
    );
    return res.status(200).json({ received: true });
  }

  // 5. Download signed PDF from Signum
  const pdfBuffer = await downloadSignedPdf(payload.documentId);

  // 6. Store PDF to /storage/afs-signed/{companyId}/{documentId}.pdf
  const storagePath = `/storage/afs-signed/${doc.company_id}/${doc.id}.pdf`;
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, pdfBuffer);

  // 7. Update afs_document: status → 'signed_off', locked_at, signed_pdf_path
  await sql`
    UPDATE afs_documents
    SET status          = 'signed_off',
        locked_at       = now(),
        signed_pdf_path = ${storagePath},
        updated_at      = now()
    WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
  `;

  // 8. Notify portal contacts
  await notifyDocumentSignedOff(doc.company_id, doc.id);

  log.info(
    'Document signed off via Signum webhook',
    { documentId: doc.id, signumDocumentId: payload.documentId },
    'signum-webhook',
  );
  return res.status(200).json({ received: true });
}

export default withErrorHandler(handler as never);
