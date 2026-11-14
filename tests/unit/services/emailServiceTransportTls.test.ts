/**
 * #1368 (WP7): the transport security of sendEmail when it holds the socket for its deadline.
 *
 *  (a) Port 465 is implicit TLS: the handshake comes before any SMTP byte, with the certificate verified, whether
 *      sendEmail hands nodemailer its own deadline socket or not.
 *  (b) Every other port must upgrade with STARTTLS before AUTH: a server that offers no STARTTLS is refused and
 *      never sees the credentials.
 *  (c) The deadline: a server that accepts and never answers is cut off AT the deadline, its socket destroyed.
 *
 * Real nodemailer, real sockets on 127.0.0.1 (tests/helpers/fakeSmtpServer.ts). Port 465 cannot be bound here, so
 * the client's connect to 465 is redirected to the fake server's port; the client trusts the throwaway test
 * certificate as a CA (verification is never switched off). Recipients are on the reserved .test TLD.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestCert, startFakeSmtp, watchClientSockets, type ClientSocketWatch, type FakeSmtp, type TestCert } from '../../helpers/fakeSmtpServer';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendEmail } from '@/modules/accounting/services/core/emailService';

let cert: TestCert;
let fake: FakeSmtp | null = null;
let watch: ClientSocketWatch | null = null;
const ENV = process.env;

beforeAll(() => { cert = makeTestCert(); });
beforeEach(() => {
  process.env = { ...ENV, SMTP_HOST: '127.0.0.1', SMTP_USER: 'u', SMTP_PASS: 'secret-pass', SMTP_FROM: 'from@tls.example.test' };
  delete process.env.SMTP_TLS_SERVERNAME;
});
afterEach(async () => {
  watch?.restore();
  watch = null;
  await fake?.close();
  fake = null;
  process.env = ENV;
});
afterAll(() => { process.env = ENV; });

const TIMEOUTS = { connection: 5_000, greeting: 5_000, socket: 5_000 };
const message = { to: 'billing@tls.example.test', subject: 'tls', html: '<p>x</p>', smtpTimeoutsMs: TIMEOUTS };
const authLines = () => fake!.lines.filter((l) => /^AUTH\b/i.test(l.line));
/** Lines that crossed in plaintext beyond the two a STARTTLS negotiation needs (no AUTH, MAIL, RCPT, DATA, body). */
const cleartextPastNegotiation = () => fake!.lines.filter((l) => !l.secure && !/^(EHLO|STARTTLS)\b/i.test(l.line));
const withAndWithoutDeadline = [['with the deadline socket', { deadlineMs: 10_000 }], ['without a deadline', {}]] as const;

describe('(a) port 465: implicit TLS', () => {
  it.each(withAndWithoutDeadline)('%s: TLS handshake before any SMTP byte, cert verified, message delivered', async (_l, extra) => {
    fake = await startFakeSmtp({ tls: 'implicit', cert });
    watch = watchClientSockets({ ca: cert.cert, redirect: { from: 465, to: fake.port } });
    process.env.SMTP_PORT = '465';

    const r = await sendEmail({ ...message, ...extra });

    expect(r.success, r.error).toBe(true);
    expect(fake.tlsErrors).toBe(0); // a plaintext byte first would have failed the handshake
    expect(fake.handshakes).toBe(1);
    expect(fake.lines.length).toBeGreaterThan(0);
    expect(fake.lines.filter((l) => !l.secure)).toEqual([]);
    expect(authLines()).toHaveLength(1);
    expect(fake.accepted).toBe(1);
    expect(watch.tlsSockets.length).toBeGreaterThan(0);
  }, 15_000);

  it('refuses a certificate it was not told to trust (verification stays on)', async () => {
    fake = await startFakeSmtp({ tls: 'implicit', cert });
    watch = watchClientSockets({ redirect: { from: 465, to: fake.port } }); // no ca
    process.env.SMTP_PORT = '465';

    const r = await sendEmail({ ...message, deadlineMs: 10_000 });

    expect(r.success).toBe(false);
    expect(fake.lines).toEqual([]);
  }, 15_000);
});

describe('(b) any other port: STARTTLS is mandatory', () => {
  it.each(withAndWithoutDeadline)('%s: a server offering no STARTTLS is refused and never receives AUTH', async (_l, extra) => {
    fake = await startFakeSmtp({ tls: 'none' });
    watch = watchClientSockets({ ca: cert.cert });
    process.env.SMTP_PORT = String(fake.port);

    const r = await sendEmail({ ...message, ...extra });

    expect(authLines()).toEqual([]); // the credentials never crossed in plaintext
    expect(cleartextPastNegotiation()).toEqual([]);
    expect(r.success).toBe(false);
    expect(r.provablyNotSent).toBe(true);
    expect(fake.accepted).toBe(0);
  }, 15_000);

  it.each(withAndWithoutDeadline)('%s: a STARTTLS server gets AUTH only after the upgrade', async (_l, extra) => {
    fake = await startFakeSmtp({ tls: 'starttls', cert });
    watch = watchClientSockets({ ca: cert.cert });
    process.env.SMTP_PORT = String(fake.port);

    const r = await sendEmail({ ...message, ...extra });

    expect(r.success, r.error).toBe(true);
    expect(fake.handshakes).toBe(1);
    expect(authLines()).toEqual([expect.objectContaining({ secure: true })]);
    expect(cleartextPastNegotiation()).toEqual([]);
    expect(fake.accepted).toBe(1);
  }, 15_000);
});

describe('(c) the deadline against a server that accepts and never replies', () => {
  const DEADLINE_MS = 600;
  it.each([['port 465 (implicit TLS)', 'implicit'], ['another port (plaintext until STARTTLS)', 'none']] as const)(
    '%s: settles at the deadline, outcome unknown, client socket destroyed',
    async (_l, mode) => {
      fake = await startFakeSmtp({ tls: mode, cert, silent: true });
      watch = watchClientSockets({ ca: cert.cert, redirect: { from: 465, to: fake.port } });
      process.env.SMTP_PORT = mode === 'implicit' ? '465' : String(fake.port);

      const started = Date.now();
      const r = await sendEmail({ ...message, deadlineMs: DEADLINE_MS });
      const took = Date.now() - started;

      expect(r).toMatchObject({ success: false, provablyNotSent: false });
      expect(r.error).toMatch(/deadline/i);
      expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(took).toBeLessThan(DEADLINE_MS + 1_000);
      const clientSockets = [...watch.sockets, ...watch.tlsSockets];
      expect(clientSockets.length).toBeGreaterThan(0);
      // The socket sendEmail holds is destroyed at once; a TLS socket layered on it (465) follows within a tick or two.
      expect(watch.sockets.filter((s) => !s.destroyed).length, 'plain client sockets left open').toBe(0);
      await vi.waitFor(() => expect(clientSockets.filter((s) => !s.destroyed).length, 'client sockets left open').toBe(0), { timeout: 300 });
      // The server sees the connection go well before nodemailer's own 5 s timers would have ended it.
      await vi.waitFor(() => expect(fake!.closed).toBeGreaterThan(0), { timeout: 1_000 });
    },
    15_000,
  );
});
