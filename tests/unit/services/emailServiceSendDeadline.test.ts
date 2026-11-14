/**
 * WP7 review round 4 of #1368: nodemailer's socketTimeout is an INACTIVITY timer, so a server that answers every
 * step just inside it can keep one send going far past the sum of the timeouts. sendEmail's `deadlineMs` is a hard
 * ceiling on the whole conversation: past it the transport is closed and the result is a failure whose outcome is
 * unknown (provablyNotSent false: the server may already have accepted the message).
 *
 * Real nodemailer against a real local SMTP server (127.0.0.1, a port the OS hands out) that delays every reply by
 * STEP_MS (tests/helpers/fakeSmtpServer.ts, STARTTLS offered): each step is well under socketTimeout, the whole
 * conversation is well past the deadline. Nothing leaves this machine; the recipient is on the reserved .test TLD.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestCert, startFakeSmtp, watchClientSockets, type ClientSocketWatch, type FakeSmtp } from '../../helpers/fakeSmtpServer';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendEmail } from '@/modules/accounting/services/core/emailService';

const STEP_MS = 400;       // every reply's delay: far under socketTimeout
const SOCKET_MS = 2_000;   // nodemailer's inactivity timer for this test
const DEADLINE_MS = 1_500; // the hard ceiling; the conversation needs ~9 steps (STARTTLS included) = ~3.6 s
// A slow server that offers STARTTLS (sendEmail requires it off port 465); the client trusts its test certificate.
let server: FakeSmtp;
let watch: ClientSocketWatch;
let port = 0;

beforeAll(async () => {
  const cert = makeTestCert();
  server = await startFakeSmtp({ tls: 'starttls', cert, delayMs: STEP_MS });
  port = server.port;
  watch = watchClientSockets({ ca: cert.cert });
});
afterAll(async () => {
  watch.restore();
  await server.close();
});

const ENV = process.env;
beforeEach(() => {
  server.closed = 0;
  server.accepted = 0;
  process.env = { ...ENV, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'from@slow.example.test' };
});
afterEach(() => { process.env = ENV; });

const message = { to: 'billing@slow.example.test', subject: 'slow', html: '<p>x</p>',
  smtpTimeoutsMs: { connection: SOCKET_MS, greeting: SOCKET_MS, socket: SOCKET_MS } };

describe('sendEmail hard deadline', () => {
  it('without a deadline the slow server is still answered: every step is under socketTimeout (the gap)', async () => {
    const started = Date.now();
    const r = await sendEmail(message);
    expect(r.success, r.error).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(DEADLINE_MS); // it took longer than any deadline we would set
  }, 20_000);

  it('with deadlineMs it aborts at the deadline, closes the connection, and the outcome is unknown', async () => {
    const started = Date.now();
    const r = await sendEmail({ ...message, deadlineMs: DEADLINE_MS });
    const took = Date.now() - started;
    expect(r).toMatchObject({ success: false, provablyNotSent: false });
    expect(r.error).toMatch(/deadline/i);
    expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(took).toBeLessThan(DEADLINE_MS + 1_000);
    await vi.waitFor(() => expect(server.closed).toBeGreaterThan(0), { timeout: 3_000 });
    // Closed AT the deadline, not left to finish: the abandoned conversation never delivered the message.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(server.accepted).toBe(0);
  }, 20_000);

  it('a send that finishes inside the deadline is delivered through the socket the deadline holds', async () => {
    const r = await sendEmail({ ...message, deadlineMs: 10_000 });
    expect(r.success, r.error).toBe(true);
    expect(server.accepted).toBe(1);
  }, 20_000);
});
