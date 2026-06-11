/**
 * Twilio media download helper — PRD-05 Phase 8.
 * Extracted from whatsAppInboundService.ts (300-line file cap).
 */

import { log } from '@/lib/logger';

/**
 * Fetch a Twilio media URL using HTTP basic-auth (SID + token).
 * Returns null when env vars are absent, logging a warning.
 * SSRF guard: only fetches from *.twilio.com / *.twiliocdn.com hosts.
 */
export async function fetchTwilioMedia(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  // SSRF hostname allowlist: only fetch from Twilio-owned domains.
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch (_err) {
    log.warn('twilioMediaFetch: invalid media URL', { url }, 'whatsapp-inbound');
    return null;
  }
  const allowed =
    host === 'api.twilio.com' ||
    host.endsWith('.twilio.com') ||
    host.endsWith('.twiliocdn.com');
  if (!allowed) {
    log.warn('twilioMediaFetch: refusing non-Twilio media host', { host }, 'whatsapp-inbound');
    return null;
  }

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
