/**
 * WP7 review of #1368 (M1/M2): sendEmail passes a caller's SMTP bounds to nodemailer (and only then: every other
 * caller keeps nodemailer's defaults), and says whether a failed send provably did not leave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({ messageId: 'mid' }));
const createTransport = vi.fn((_cfg: Record<string, unknown>) => ({ sendMail }));
vi.mock('nodemailer', () => ({ default: { createTransport }, createTransport }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendEmail } from '@/modules/accounting/services/core/emailService';

const ENV = process.env;
beforeEach(() => {
  process.env = { ...ENV, SMTP_HOST: 'smtp.mock.invalid', SMTP_USER: 'u', SMTP_PASS: 'p' };
  createTransport.mockClear();
  sendMail.mockClear();
});
afterEach(() => { process.env = ENV; });

const base = { to: 'a@x.example.test', subject: 's', html: '<p>h</p>' };

describe('sendEmail SMTP bounds', () => {
  it('passes smtpTimeoutsMs as connection / greeting / socket timeouts', async () => {
    await sendEmail({ ...base, smtpTimeoutsMs: { connection: 15000, greeting: 15000, socket: 20000 } });
    expect(createTransport.mock.calls[0]![0]).toMatchObject({ connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  });

  it('leaves nodemailer defaults alone for a caller that gives none', async () => {
    await sendEmail(base);
    const cfg = createTransport.mock.calls[0]![0];
    expect(['connectionTimeout', 'greetingTimeout', 'socketTimeout'].filter((k) => k in cfg)).toEqual([]);
  });
});

describe('sendEmail provablyNotSent', () => {
  it.each([
    [{ code: 'EENVELOPE' }, true],
    [{ code: 'EAUTH' }, true],
    [{ responseCode: 550 }, true],
    [{ code: 'ESOCKET', syscall: 'connect' }, true],
    [{ code: 'ETIMEDOUT' }, false],
    [{ code: 'ECONNRESET' }, false],
  ])('%o -> %s', async (shape, notSent) => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('boom'), shape));
    const r = await sendEmail(base);
    expect(r).toMatchObject({ success: false, provablyNotSent: notSent });
  });

  it('is true when SMTP is not configured', async () => {
    process.env = { ...ENV, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '' };
    expect(await sendEmail(base)).toMatchObject({ success: false, provablyNotSent: true });
  });
});
