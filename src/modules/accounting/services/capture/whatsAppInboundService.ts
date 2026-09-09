/**
 * WhatsApp Inbound Service — PRD-05 Phase 8
 * Processes Twilio WABA webhook payloads into captured_documents + capture_events.
 * Mirrors inboundEmailService patterns.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import { routeEvent } from './captureRouterService';
import {
  parseExpenseCommand,
  type WhatsAppExpenseCommand,
} from './whatsAppTextCommandParser';
import {
  findOpenQuery,
  attachReplyMedia,
  markQueryReplied,
} from './bankTxQueryReplyService';
import { fetchTwilioMedia } from './twilioMediaFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TwilioInboundPayload {
  From: string;               // 'whatsapp:+27...'
  To: string;                 // 'whatsapp:+...' (company WABA number)
  Body?: string;
  NumMedia?: string;          // string int
  MessageSid: string;
  ProfileName?: string;
  [mediaKey: string]: unknown; // MediaUrl0..N, MediaContentType0..N
}

export type IngestResult =
  | { rejected: string }
  | {
      captureEventIds: string[];
      companyId: string;
      parsedCommand: WhatsAppExpenseCommand | null;
    };

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_MEDIA_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
]);

function isAllowedMime(mime: string): boolean {
  return ALLOWED_MEDIA_TYPES.has(mime.toLowerCase().split(';')[0]!.trim());
}

function mimeToExt(mime: string): string {
  const clean = mime.toLowerCase().split(';')[0]!.trim();
  if (clean === 'application/pdf') return 'pdf';
  return clean.split('/')[1] ?? 'bin';
}

/** Strip the "whatsapp:" prefix from a Twilio address. */
function stripWaPrefix(addr: string): string {
  return addr.replace(/^whatsapp:/i, '').trim();
}

type Row = Record<string, unknown>;

// ─── Core ingestion ───────────────────────────────────────────────────────────

export async function ingestTwilioPayload(
  payload: TwilioInboundPayload,
  binding?: { companyId: string; inboxId: string; tokenHash: string },
): Promise<IngestResult> {
  if (!binding) return { rejected: 'destination verification required' };
  // Recheck the verified binding before any ingestion effects.
  const toNumber = stripWaPrefix(payload.To);
  if (!toNumber) {
    log.warn(
      'whatsAppInbound: could not parse To address',
      { to: payload.To },
      'whatsapp-inbound',
    );
    return { rejected: 'no matching inbox' };
  }

  const inboxRows = (await sql`
    SELECT id, company_id
    FROM capture_inboxes
    WHERE company_id = ${binding.companyId}::uuid AND id = ${binding.inboxId}::uuid
      AND webhook_token_hash = ${binding.tokenHash} AND provider_verified_at IS NOT NULL
      AND btrim(address) = ${toNumber}
      AND channel = 'whatsapp'
      AND is_active = true
    LIMIT 2
  `) as Row[];

  if (inboxRows.length === 0) {
    log.info(
      'whatsAppInbound: no active whatsapp inbox',
      { toNumber },
      'whatsapp-inbound',
    );
    return { rejected: 'no matching inbox' };
  }

  if (inboxRows.length > 1) {
    log.warn('whatsAppInbound: ambiguous destination rejected', { toNumber }, 'whatsapp-inbound');
    return { rejected: 'ambiguous inbox' };
  }

  const inbox = inboxRows[0]!;
  const companyId = String(inbox.company_id);
  const inboxId = String(inbox.id);

  // Workstream D: is this sender replying to an open bank-tx query?
  // All query-loop calls fail OPEN — a throw here would 500 the webhook and
  // make Twilio retry, re-ingesting the document (no MessageSid dedupe).
  const openQuery = await findOpenQuery(companyId, stripWaPrefix(payload.From)).catch(
    (err: unknown) => {
      log.warn('whatsAppInbound: query lookup failed — proceeding without reply routing', {
        companyId, error: err instanceof Error ? err.message : String(err),
      }, 'whatsapp-inbound');
      return null;
    },
  );

  const eventIds: string[] = [];
  // Cap at 10 — Twilio's real per-message media limit.
  const numMedia = Math.min(parseInt(payload.NumMedia ?? '0', 10), 10);

  // 2. Process each media attachment
  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = payload[`MediaUrl${i}`] as string | undefined;
    const rawContentType =
      (payload[`MediaContentType${i}`] as string | undefined) ?? '';

    if (!mediaUrl) continue;

    const mimeType = rawContentType.toLowerCase().split(';')[0]!.trim();
    if (!isAllowedMime(mimeType)) {
      log.info(
        'whatsAppInbound: skipping unsupported media type',
        { mimeType, companyId },
        'whatsapp-inbound',
      );
      continue;
    }

    const media = await fetchTwilioMedia(mediaUrl);
    if (!media) continue; // warn already logged inside fetchTwilioMedia

    const fileExt = mimeToExt(media.contentType);
    const fileName = `whatsapp_${payload.MessageSid}_${i}.${fileExt}`;
    const buffer = media.buffer;
    const hash = sha256(buffer);
    const size = buffer.length;
    const notes = `whatsapp-ingest: from=${payload.From} sid=${payload.MessageSid}`;

    // 2a. Insert captured_documents row
    const docRows = (await sql`
      INSERT INTO captured_documents (
        company_id, file_name, file_type, file_size,
        document_type, status, notes, uploaded_by,
        raw_bytes_sha256, raw_bytes_size
      ) VALUES (
        ${companyId},
        ${fileName},
        ${fileExt},
        ${size},
        'invoice',
        'pending',
        ${notes},
        null,
        ${hash},
        ${size}
      )
      RETURNING id
    `) as Row[];

    const documentId = String(docRows[0]!.id);

    // 2b. Upload to Storage
    const stored = await storeCapturedBytes(companyId, documentId, buffer, mimeType);

    // 2c. Write back pointer
    await sql`
      UPDATE captured_documents
      SET storage_bucket = ${stored.bucket},
          storage_path   = ${stored.path}
      WHERE id = ${documentId}::uuid
        AND company_id = ${companyId}
    `;

    // 2d. Insert capture_event
    const eventRows = (await sql`
      INSERT INTO capture_events (
        company_id, inbox_id, channel, sender, subject,
        status, captured_document_id, received_at
      ) VALUES (
        ${companyId},
        ${inboxId}::uuid,
        'whatsapp',
        ${payload.From},
        ${payload.MessageSid},
        'received',
        ${documentId}::uuid,
        NOW()
      )
      RETURNING id
    `) as Row[];

    const eventId = String(eventRows[0]!.id);
    eventIds.push(eventId);

    log.info('whatsAppInbound: capture event created', {
      companyId, inboxId, documentId, eventId, fileName, size, hash,
    }, 'whatsapp-inbound');

    // Workstream D: attach media to the queried bank transaction if open
    if (openQuery) {
      await attachReplyMedia(companyId, openQuery, { buffer, mimeType, fileName }).catch(
        (err: unknown) => {
          log.warn('whatsAppInbound: reply media attach failed', {
            companyId, queryId: openQuery.id, fileName,
            error: err instanceof Error ? err.message : String(err),
          }, 'whatsapp-inbound');
        },
      );
    }

    // 2e. Fire-and-forget VLM extraction
    routeEvent(eventId, companyId).catch((err: unknown) => {
      log.error('whatsAppInbound: routeEvent background error', {
        captureEventId: eventId,
        error: err instanceof Error ? err.message : String(err),
      }, 'whatsapp-inbound');
    });
  }

  // 3. Parse text body for expense command
  const parsedCommand =
    payload.Body ? parseExpenseCommand(payload.Body) : null;

  // 4. When we have a parsed command and no media-derived event, materialise a
  //    text-only capture_event so the inbox shows the intent for human review
  //    (the user promotes to a provisional JE from there). We deliberately do
  //    NOT auto-post — PRD §9 bans auto-publish of unverified GL data.
  if (parsedCommand && eventIds.length === 0) {
    const subject = payload.Body
      ? `text: ${payload.Body.slice(0, 120)}`
      : `text: (command: ${parsedCommand.action})`;
    const eventRows = (await sql`
      INSERT INTO capture_events (
        company_id, inbox_id, channel, sender, subject, status, received_at,
        error
      ) VALUES (
        ${companyId},
        ${inboxId}::uuid,
        'whatsapp',
        ${payload.From},
        ${subject},
        'extracted',
        NOW(),
        ${'wa-text-command: R' + parsedCommand.amount + ' / ' + (parsedCommand.supplierHint ?? '?')}
      )
      RETURNING id
    `) as Row[];
    const eventId = String(eventRows[0]!.id);
    eventIds.push(eventId);
    log.info('whatsAppInbound: text-command capture event created', {
      companyId, inboxId, eventId, parsedCommand,
    }, 'whatsapp-inbound');
  }

  // Workstream D: flip the query to replied (text and/or media)
  const replyBody = (payload.Body ?? '').trim();
  if (openQuery && (eventIds.length > 0 || replyBody)) {
    await markQueryReplied(companyId, openQuery.id, replyBody || null, eventIds[0] ?? null)
      .catch((err: unknown) => {
        log.warn('whatsAppInbound: mark replied failed', {
          companyId, queryId: openQuery.id,
          error: err instanceof Error ? err.message : String(err),
        }, 'whatsapp-inbound');
      });
  }

  return { captureEventIds: eventIds, companyId, parsedCommand };
}
