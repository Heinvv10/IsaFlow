/**
 * sendWhatsAppMessage's failure shapes (WP7): it never throws for a provider error; it returns { sent: false } and, when
 * the failure does not prove the message stayed in (no HTTP answer, a 5xx or 408), `ambiguous: true`. A 4xx validation
 * error and "not configured" are definite. The Twilio call is cut off after TWILIO_TIMEOUT_MS. Twilio is mocked: nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const factory = vi.fn((_sid: string, _token: string, _opts?: unknown) => ({ messages: { create } }));
vi.mock('twilio', () => ({ default: (...a: [string, string, unknown?]) => factory(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { isAmbiguousSendFailure, sendWhatsAppMessage, TWILIO_TIMEOUT_MS } from '@/modules/accounting/services/capture/whatsAppReplyService';

beforeEach(() => {
  create.mockReset(); factory.mockClear();
  process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'token';
});
afterEach(() => { delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; });

describe('sendWhatsAppMessage failure shapes', () => {
  it('not configured is a definite refusal: sent false, no ambiguous flag, nothing called', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const r = await sendWhatsAppMessage('whatsapp:+27821234567', 'hi');
    expect(r).toEqual({ sent: false, reason: 'twilio not configured' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('a confirmed send returns the sid', async () => {
    create.mockResolvedValue({ sid: 'SM1' });
    expect(await sendWhatsAppMessage('whatsapp:+27821234567', 'hi')).toEqual({ sent: true, sid: 'SM1' });
  });

  it.each([
    ['a 400 validation error', Object.assign(new Error('The To number is not valid'), { status: 400 }), false],
    ['a 401', Object.assign(new Error('Authenticate'), { status: 401 }), false],
    ['a 429', Object.assign(new Error('Too many requests'), { status: 429 }), false],
    ['a 500', Object.assign(new Error('Server error'), { status: 500 }), true],
    ['a 503', Object.assign(new Error('Unavailable'), { status: 503 }), true],
    ['a 408', Object.assign(new Error('Request Timeout'), { status: 408 }), true],
    ['a connection reset (no HTTP status)', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), true],
    ['a timeout (no HTTP status)', Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }), true],
    ['a non-Error rejection', 'boom', true],
  ])('%s: ambiguous = %s', async (_n, err, ambiguous) => {
    create.mockRejectedValue(err);
    const r = await sendWhatsAppMessage('whatsapp:+27821234567', 'hi');
    expect(r.sent).toBe(false);
    expect(r.ambiguous === true).toBe(ambiguous);
    expect(isAmbiguousSendFailure(err)).toBe(ambiguous);
  });

  it('the Twilio client is created with a timeout', async () => {
    create.mockResolvedValue({ sid: 'SM1' });
    await sendWhatsAppMessage('whatsapp:+27821234567', 'hi');
    expect(factory).toHaveBeenCalledWith('ACtest', 'token', { timeout: TWILIO_TIMEOUT_MS });
    expect(TWILIO_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
