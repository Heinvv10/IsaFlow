// RED phase — written before implementation
/**
 * Unit tests for whatsAppReplyService.ts — PRD-05 Phase 8
 *
 * Covers:
 *   composePostingConfirmation (pure) — posted, provisional, error variants
 *   sendWhatsAppMessage (IO)          — env unset, twilio success, twilio throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Twilio SDK mock ───────────────────────────────────────────────────────────

const { twilioCreateMock } = vi.hoisted(() => {
  const twilioCreateMock = vi.fn().mockResolvedValue({ sid: 'SM123' });
  return { twilioCreateMock };
});

vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    messages: { create: twilioCreateMock },
  })),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  composePostingConfirmation,
  sendWhatsAppMessage,
  type PostingConfirmationInput,
} from '@/modules/accounting/services/capture/whatsAppReplyService';

// ─── composePostingConfirmation ───────────────────────────────────────────────

describe('composePostingConfirmation — posted', () => {
  it('contains "Posted" and the GL account name', () => {
    const msg = composePostingConfirmation({
      status: 'posted',
      glAccountName: 'Fuel & Oil',
      amount: 850,
      vatAmount: 110.87,
      supplierName: 'Shell',
    } satisfies PostingConfirmationInput);
    expect(msg).toContain('Posted');
    expect(msg).toContain('Fuel & Oil');
  });

  it('includes the amount formatted as R850', () => {
    const msg = composePostingConfirmation({
      status: 'posted',
      glAccountName: 'Fuel & Oil',
      amount: 850,
      vatAmount: 110.87,
      supplierName: 'Shell',
    } satisfies PostingConfirmationInput);
    expect(msg).toMatch(/R850|R 850/);
  });

  it('includes the VAT amount when vatAmount is provided', () => {
    const msg = composePostingConfirmation({
      status: 'posted',
      glAccountName: 'Groceries',
      amount: 500,
      vatAmount: 65.22,
      supplierName: 'Checkers',
    } satisfies PostingConfirmationInput);
    expect(msg).toMatch(/VAT.*R|R.*VAT/i);
  });

  it('omits VAT line when vatAmount is not provided', () => {
    const msg = composePostingConfirmation({
      status: 'posted',
      glAccountName: 'Groceries',
      amount: 500,
      supplierName: 'Checkers',
    } satisfies PostingConfirmationInput);
    expect(msg).not.toMatch(/VAT R\d/i);
  });

  it('includes supplier name after em-dash or separator', () => {
    const msg = composePostingConfirmation({
      status: 'posted',
      glAccountName: 'Fuel & Oil',
      amount: 850,
      supplierName: 'Shell',
    } satisfies PostingConfirmationInput);
    expect(msg).toContain('Shell');
  });

  it('omits trailing supplier segment when supplierName is absent', () => {
    const msg = composePostingConfirmation({
      status: 'posted',
      glAccountName: 'Fuel & Oil',
      amount: 850,
    } satisfies PostingConfirmationInput);
    // Should not contain an em-dash dangling at end
    expect(msg.trim()).not.toMatch(/[—–-]\s*$/);
  });
});

describe('composePostingConfirmation — provisional', () => {
  it('contains "provisional" (case-insensitive)', () => {
    const msg = composePostingConfirmation({
      status: 'provisional',
      amount: 200,
      supplierName: 'Pick n Pay',
    } satisfies PostingConfirmationInput);
    expect(msg.toLowerCase()).toContain('provisional');
  });

  it('contains "evidence needed" phrase', () => {
    const msg = composePostingConfirmation({
      status: 'provisional',
      amount: 200,
      supplierName: 'Pick n Pay',
    } satisfies PostingConfirmationInput);
    expect(msg.toLowerCase()).toContain('evidence');
  });

  it('includes the amount', () => {
    const msg = composePostingConfirmation({
      status: 'provisional',
      amount: 200,
      supplierName: 'Pick n Pay',
    } satisfies PostingConfirmationInput);
    expect(msg).toMatch(/R200|R 200/);
  });
});

describe('composePostingConfirmation — error', () => {
  it('contains "Could not post" phrase', () => {
    const msg = composePostingConfirmation({
      status: 'error',
      errorReason: 'duplicate transaction',
    } satisfies PostingConfirmationInput);
    expect(msg.toLowerCase()).toContain('could not post');
  });

  it('includes the errorReason', () => {
    const msg = composePostingConfirmation({
      status: 'error',
      errorReason: 'duplicate transaction',
    } satisfies PostingConfirmationInput);
    expect(msg).toContain('duplicate transaction');
  });
});

// ─── sendWhatsAppMessage ──────────────────────────────────────────────────────

describe('sendWhatsAppMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WHATSAPP_FROM;
    twilioCreateMock.mockResolvedValue({ sid: 'SM123' });
  });

  it('returns {sent: false, reason: "twilio not configured"} when TWILIO_ACCOUNT_SID is undefined', async () => {
    const result = await sendWhatsAppMessage('+27611111111', 'Hello');
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('twilio not configured');
  });

  it('returns {sent: true} when env is set and twilio create succeeds', async () => {
    process.env.TWILIO_ACCOUNT_SID  = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN   = 'authtoken';
    process.env.TWILIO_WHATSAPP_FROM = '+27600000000';

    const result = await sendWhatsAppMessage('+27611111111', 'Hello');
    expect(result.sent).toBe(true);
  });

  it('returns {sent: false, reason: <message>} when twilio SDK throws', async () => {
    process.env.TWILIO_ACCOUNT_SID  = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN   = 'authtoken';
    process.env.TWILIO_WHATSAPP_FROM = '+27600000000';
    twilioCreateMock.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const result = await sendWhatsAppMessage('+27611111111', 'Hello');
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('Rate limit exceeded');
  });
});
