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
  const client = twilioMod.default(accountSid, authToken);

  try {
    const msg = await client.messages.create({ from, to, body });
    log.info('sendWhatsAppMessage: sent', {
      to, from, messageSid: msg.sid,
    }, 'whatsapp-reply');
    return { sent: true, sid: msg.sid };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('sendWhatsAppMessage: send failed', { to, reason }, 'whatsapp-reply');
    return { sent: false, reason };
  }
}
