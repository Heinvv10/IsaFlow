/**
 * Twilio redelivery dedupe for WhatsApp ingestion (K-160, migration 700).
 * A capture_event is keyed by (company_id, provider_message_id, provider_message_part):
 * the part is the media index, or TEXT_PART for the text-command event.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { removeCapturedDocument } from '@/lib/supabaseStorage';
import type { TwilioInboundPayload } from './whatsAppInboundService';
import type { WhatsAppExpenseCommand } from './whatsAppTextCommandParser';

const TEXT_PART = -1;

/** Parts of this Twilio message that an earlier delivery already ingested. */
export async function ingestedParts(companyId: string, messageSid: string): Promise<Set<number>> {
  const rows = (await sql`
    SELECT provider_message_part
    FROM capture_events
    WHERE company_id = ${companyId}::uuid AND provider_message_id = ${messageSid}
  `) as Array<{ provider_message_part: number }>;
  return new Set(rows.map((r) => Number(r.provider_message_part)));
}

/**
 * A concurrent delivery of the same message claimed this part first: drop the
 * captured_documents row this delivery inserted so the inbox holds one copy,
 * then its uploaded object. The object delete is best-effort — a failure is
 * logged and the webhook still answers 200.
 */
export async function discardLostRaceDocument(
  companyId: string, documentId: string, stored: { bucket: string; path: string }, messageSid: string,
): Promise<void> {
  await sql`
    DELETE FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
  `;
  log.warn('whatsAppInbound: concurrent redelivery lost the race — duplicate document discarded', {
    companyId, documentId, storagePath: stored.path, messageSid,
  }, 'whatsapp-inbound');
  try {
    await removeCapturedDocument(stored.bucket, stored.path);
  } catch (err: unknown) {
    log.warn('whatsAppInbound: duplicate document object not removed — orphaned in storage', {
      companyId, documentId, bucket: stored.bucket, storagePath: stored.path,
      error: err instanceof Error ? err.message : String(err),
    }, 'whatsapp-inbound');
  }
}

/**
 * Materialise the text-command capture_event. Returns null when a concurrent
 * delivery of the same message already inserted it.
 */
export async function insertTextCommandEvent(
  companyId: string, inboxId: string,
  payload: TwilioInboundPayload, parsedCommand: WhatsAppExpenseCommand,
): Promise<string | null> {
  const subject = payload.Body
    ? `text: ${payload.Body.slice(0, 120)}`
    : `text: (command: ${parsedCommand.action})`;
  const eventRows = (await sql`
    INSERT INTO capture_events (
      company_id, inbox_id, channel, sender, subject, status, received_at,
      error, provider_message_id, provider_message_part
    ) VALUES (
      ${companyId},
      ${inboxId}::uuid,
      'whatsapp',
      ${payload.From},
      ${subject},
      'extracted',
      NOW(),
      ${'wa-text-command: R' + parsedCommand.amount + ' / ' + (parsedCommand.supplierHint ?? '?')},
      ${payload.MessageSid},
      ${TEXT_PART}
    )
    ON CONFLICT (company_id, provider_message_id, provider_message_part)
      WHERE provider_message_id IS NOT NULL DO NOTHING
    RETURNING id
  `) as Array<{ id: string }>;
  if (eventRows.length === 0) return null;
  const eventId = String(eventRows[0]!.id);
  log.info('whatsAppInbound: text-command capture event created', {
    companyId, inboxId, eventId, parsedCommand,
  }, 'whatsapp-inbound');
  return eventId;
}
