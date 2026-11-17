/**
 * WhatsApp Reply Service — PRD-05 Phase 8
 * Sends outbound WhatsApp messages via Twilio WABA SDK.
 * Gracefully degrades when Twilio env vars are absent.
 */

import { log } from '@/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PostingConfirmationInput {
  status: 'posted' | 'provisional' | 'error';
  glAccountName?: string;
  amount?: number;
  vatAmount?: number;
  supplierName?: string;
  errorReason?: string;
}

export interface SendResult {
  sent: boolean;
  reason?: string;
  sid?: string;
  /**
   * Only with `sent: false`. True when the failure does NOT prove the message stayed in: a timeout, a connection
   * reset, a 5xx or 408 from the provider (it may have been accepted before the answer was lost). False or absent: a
   * definite refusal (not configured, a 4xx validation error), the message did not go. Callers that do not care (the
   * chase, the inbound replies) ignore it.
   */
  ambiguous?: boolean;
}

/** The provider call is cut off after this long: a hung connection must not hold the request (and its row lock) open. */
export const TWILIO_TIMEOUT_MS = 10_000;

/** Whether a failed provider call leaves open that the message went out. Twilio's RestException carries the HTTP `status`. */
export function isAmbiguousSendFailure(err: unknown): boolean {
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  if (typeof status !== 'number') return true; // no HTTP answer at all: network, DNS, reset, timeout
  return status >= 500 || status === 408;
}

// ─── Pure composer ────────────────────────────────────────────────────────────

/**
 * Compose a WhatsApp-friendly posting confirmation message.
 * Pure function — no side effects.
 *
 * Examples:
 *   posted    → "✅ Posted to Motor Expenses R850.00 (VAT R113.04) — Shell"
 *   provisional → "⚠ Posted as provisional R850.00 — Shell (evidence needed)"
 *   error     → "❌ Could not post: supplier not matched. Please check the inbox."
 */
export function composePostingConfirmation(
  input: PostingConfirmationInput,
): string {
  const { status, glAccountName, amount, vatAmount, supplierName, errorReason } = input;

  const amtStr = amount != null ? `R${amount.toFixed(2)}` : null;
  const vatStr = vatAmount != null ? ` (VAT R${vatAmount.toFixed(2)})` : '';
  const supplierStr = supplierName ? ` — ${supplierName}` : '';

  switch (status) {
    case 'posted': {
      const acctStr = glAccountName ? ` to ${glAccountName}` : '';
      return `✅ Posted${acctStr} ${amtStr ?? ''}${vatStr}${supplierStr}`.trim();
    }
    case 'provisional': {
      return `⚠ Posted as provisional ${amtStr ?? ''}${supplierStr} (evidence needed)`.trim();
    }
    case 'error':
    default: {
      const reason = errorReason ?? 'unknown error';
      return `❌ Could not post: ${reason}. Please check the inbox.`;
    }
  }
}

// ─── Sender ───────────────────────────────────────────────────────────────────

/**
 * Send a WhatsApp message to the given number via Twilio WABA.
 *
 * When TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set, returns
 * { sent: false, reason: 'twilio not configured' } — no crash.
 *
 * `to` should include the "whatsapp:" prefix (e.g. "whatsapp:+27821234567").
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
): Promise<SendResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from =
    process.env.TWILIO_WHATSAPP_FROM ?? 'whatsapp:+14155238886';

  if (!accountSid || !authToken) {
    log.warn(
      'sendWhatsAppMessage: Twilio not configured — message not sent',
      { to },
      'whatsapp-reply',
    );
    return { sent: false, reason: 'twilio not configured' };
  }

  // Lazy-import Twilio so the app boots cleanly without env vars
  const twilioMod = await import('twilio');
  const client = twilioMod.default(accountSid, authToken, { timeout: TWILIO_TIMEOUT_MS });

  try {
    const msg = await client.messages.create({ from, to, body });
    log.info('sendWhatsAppMessage: sent', {
      to, from, messageSid: msg.sid,
    }, 'whatsapp-reply');
    return { sent: true, sid: msg.sid };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('sendWhatsAppMessage: send failed', { to, reason }, 'whatsapp-reply');
    return { sent: false, reason, ambiguous: isAmbiguousSendFailure(err) };
  }
}
