/**
 * Unit tests for the SMTP TLS servername passthrough in emailService.
 *
 * The prod mail host (mail.isaflow.co.za) presents a *.jnb1.host-h.net wildcard
 * cert, so default TLS verification rejects it and every send fails. Setting
 * SMTP_TLS_SERVERNAME lets nodemailer verify against the cert's real name
 * instead of disabling verification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createTransport = vi.fn(() => ({ sendMail: vi.fn(async () => ({ messageId: 'mid' })) }));
vi.mock('nodemailer', () => ({ default: { createTransport }, createTransport }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendEmail } from '@/modules/accounting/services/core/emailService';

const ENV = process.env;
beforeEach(() => {
  process.env = { ...ENV, SMTP_HOST: 'mail.isaflow.co.za', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p' };
  createTransport.mockClear();
});
afterEach(() => { process.env = ENV; });

describe('sendEmail TLS servername', () => {
  it('passes tls.servername when SMTP_TLS_SERVERNAME is set', async () => {
    process.env.SMTP_TLS_SERVERNAME = 'www513.jnb1.host-h.net';
    const r = await sendEmail({ to: 'x@y.com', subject: 's', html: '<p>h</p>' });
    expect(r.success).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ tls: { servername: 'www513.jnb1.host-h.net' } }),
    );
  });

  it('omits the tls option entirely when SMTP_TLS_SERVERNAME is unset', async () => {
    delete process.env.SMTP_TLS_SERVERNAME;
    await sendEmail({ to: 'x@y.com', subject: 's', html: '<p>h</p>' });
    expect(createTransport).toHaveBeenCalledWith(expect.not.objectContaining({ tls: expect.anything() }));
  });
});
