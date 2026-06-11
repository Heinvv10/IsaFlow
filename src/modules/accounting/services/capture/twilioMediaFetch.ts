/**
 * Twilio media download helper — PRD-05 Phase 8.
 * Extracted from whatsAppInboundService.ts (300-line file cap).
 */

import { log } from '@/lib/logger';

/**
 * Fetch a Twilio media URL using HTTP basic-auth (SID + token).
 * Returns null when env vars are absent, logging a warning.
 */
export async function fetchTwilioMedia(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    log.warn(
      'whatsAppInbound: TWILIO_ACCOUNT_SID/AUTH_TOKEN not configured — skipping media fetch',
      { url },
      'whatsapp-inbound',
    );
    return null;
  }

  const creds = Buffer.from(`${sid}:${token}`).toString('base64');
  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${creds}` },
  });

  if (!resp.ok) {
    log.warn(
      'whatsAppInbound: media fetch failed',
      { url, status: resp.status },
      'whatsapp-inbound',
    );
    return null;
  }

  const contentType =
    resp.headers.get('content-type') ?? 'application/octet-stream';
  const arrayBuf = await resp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType };
}
