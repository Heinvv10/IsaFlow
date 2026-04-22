/**
 * Inbound Email Service
 * Processes Postmark inbound webhook payloads into capture_events + captured_documents.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Postmark inbound payload shape
// ---------------------------------------------------------------------------

export interface PostmarkAttachment {
  Name: string;
  ContentType: string;
  Content: string; // base64
  ContentLength: number;
}

export interface PostmarkInboundPayload {
  To?: string;
  ToFull?: Array<{ Email: string; Name?: string }>;
  From: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Attachments?: PostmarkAttachment[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVOICE_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
]);

function isInvoiceMime(mime: string): boolean {
  return INVOICE_MIME_TYPES.has(mime.toLowerCase().split(';')[0]!.trim());
}

function senderDomain(from: string): string {
  const match = from.match(/@([^>]+)/);
  return (match?.[1] ?? '').toLowerCase().trim();
}

type InboxRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type IngestResult =
  | { captureEventId: string; companyId: string }
  | { rejected: string };

/**
 * Process a Postmark inbound payload.
 * Resolves the company via the `To` address, validates sender allow-list,
 * and persists one captured_document + capture_event per invoice attachment.
 * Returns the first captureEventId on success.
 */
export async function ingestPostmarkPayload(
  payload: PostmarkInboundPayload,
): Promise<IngestResult> {
  // Resolve destination address
  const toAddress =
    payload.ToFull?.[0]?.Email?.toLowerCase() ??
    payload.To?.match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase() ??
    '';

  if (!toAddress) {
    log.warn('Inbound email: could not parse To address', { to: payload.To }, 'inbound-email');
    return { rejected: 'no matching inbox' };
  }

  // Look up active inbox
  const inboxRows = await sql`
    SELECT id, company_id, allowed_sender_domains
    FROM capture_inboxes
    WHERE address = ${toAddress} AND is_active = true AND channel = 'email'
    LIMIT 1
  ` as InboxRow[];

  if (inboxRows.length === 0) {
    log.info('Inbound email: no active inbox for address', { toAddress }, 'inbound-email');
    return { rejected: 'no matching inbox' };
  }

  const inbox = inboxRows[0]!;
  const companyId = inbox.company_id as string;
  const inboxId = inbox.id as string;
  const allowedDomains = inbox.allowed_sender_domains as string[] | null;

  // Sender domain check
  if (allowedDomains && allowedDomains.length > 0) {
    const fromDomain = senderDomain(payload.From);
    if (!allowedDomains.includes(fromDomain)) {
      log.warn('Inbound email: sender domain not allow-listed', { fromDomain, inboxId }, 'inbound-email');
      return { rejected: 'sender not allow-listed' };
    }
  }

  // Filter invoice attachments
  const invoiceAttachments = (payload.Attachments ?? []).filter(
    (a) => isInvoiceMime(a.ContentType),
  );

  if (invoiceAttachments.length === 0) {
    log.info('Inbound email: no invoice attachments', { inboxId, from: payload.From }, 'inbound-email');
    return { rejected: 'no attachments' };
  }

  let firstEventId: string | null = null;

  for (const attachment of invoiceAttachments) {
    const mimeType = attachment.ContentType.toLowerCase().split(';')[0]!.trim();
    const fileExt = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1] ?? 'bin';
    const fileName = attachment.Name || `email_attachment_${Date.now()}.${fileExt}`;

    // TODO: stream to object storage, set raw_payload_url
    // For now: store base64 byte count + name in notes
    const notes = `email-ingest: base64_size=${attachment.Content.length}, name=${attachment.Name}, from=${payload.From}`;

    // Insert captured_document
    const docRows = await sql`
      INSERT INTO captured_documents (
        company_id, file_name, file_type, file_size,
        document_type, status, notes, uploaded_by
      ) VALUES (
        ${companyId},
        ${fileName},
        ${fileExt},
        ${attachment.ContentLength ?? null},
        'invoice',
        'pending',
        ${notes},
        null
      )
      RETURNING id
    ` as InboxRow[];

    const documentId = docRows[0]!.id as string;

    // Insert capture_event
    const eventRows = await sql`
      INSERT INTO capture_events (
        company_id, inbox_id, channel, sender, subject,
        status, captured_document_id, received_at
      ) VALUES (
        ${companyId},
        ${inboxId}::uuid,
        'email',
        ${payload.From},
        ${payload.Subject ?? null},
        'received',
        ${documentId}::uuid,
        NOW()
      )
      RETURNING id
    ` as InboxRow[];

    const eventId = eventRows[0]!.id as string;

    if (!firstEventId) firstEventId = eventId;

    log.info('Inbound email: capture event created', {
      companyId, inboxId, documentId, eventId, fileName,
    }, 'inbound-email');
  }

  return { captureEventId: firstEventId!, companyId };
}
