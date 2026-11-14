/**
 * WP7 review round 4 of #1368: nodemailer's socketTimeout is an INACTIVITY timer, so a server that answers every
 * step just inside it can keep one send going far past the sum of the timeouts. sendEmail's `deadlineMs` is a hard
 * ceiling on the whole conversation: past it the transport is closed and the result is a failure whose outcome is
 * unknown (provablyNotSent false: the server may already have accepted the message).
 *
 * Real nodemailer against a real local SMTP server (127.0.0.1, a port the OS hands out) that delays every reply by
 * STEP_MS: each step is well under socketTimeout, the whole conversation is well past the deadline. Nothing leaves
 * this machine; the recipient is on the reserved .test TLD.
 */
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendEmail } from '@/modules/accounting/services/core/emailService';

const STEP_MS = 400;       // every reply's delay: far under socketTimeout
const SOCKET_MS = 2_000;   // nodemailer's inactivity timer for this test
const DEADLINE_MS = 1_500; // the hard ceiling; the conversation needs ~7 steps = ~2.8 s
let server: net.Server;
let port = 0;
const sockets = new Set<net.Socket>();
let closedByClient = 0;

/** A minimal SMTP server: greeting, EHLO (AUTH PLAIN), AUTH, MAIL, RCPT, DATA, end of data, QUIT, each reply delayed. */
function slowSmtp(): net.Server {
  return net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => { closedByClient += 1; sockets.delete(sock); });
    sock.on('error', () => { sockets.delete(sock); });
    const reply = (line: string) => setTimeout(() => { if (!sock.destroyed) sock.write(`${line}\r\n`); }, STEP_MS);
    let inData = false;
    let buffer = '';
    reply('220 slow.test ESMTP');
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (inData) {
        if (!buffer.includes('\r\n.\r\n')) return;
        inData = false;
        buffer = '';
        reply('250 queued');
        return;
      }
      let at: number;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const cmd = buffer.slice(0, at).toUpperCase();
        buffer = buffer.slice(at + 2);
        if (cmd.startsWith('EHLO')) reply('250-slow.test\r\n250 AUTH PLAIN');
        else if (cmd.startsWith('AUTH')) reply('235 ok');
        else if (cmd.startsWith('MAIL') || cmd.startsWith('RCPT')) reply('250 ok');
        else if (cmd === 'DATA') { inData = true; reply('354 go on'); }
        else if (cmd === 'QUIT') reply('221 bye');
        else reply('250 ok');
      }
    });
  });
}

beforeAll(async () => {
  server = slowSmtp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ENV = process.env;
beforeEach(() => {
  closedByClient = 0;
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
    await vi.waitFor(() => expect(closedByClient).toBeGreaterThan(0), { timeout: 3_000 });
  }, 20_000);
});
