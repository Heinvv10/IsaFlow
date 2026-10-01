/**
 * R-175 /review: an email the mail server may have accepted counts as use,
 * just as an AI call that timed out does. Only a failure that proves the
 * message was not accepted gives the daily send unit back.
 *
 * The real sendEmail and the real nodemailer 8 talk to a small SMTP server in
 * this process, which can refuse at each step or drop the connection. The
 * classes nodemailer cannot be made to produce here quickly (a timeout, DNS)
 * are given as the error shapes its source produces (lib/smtp-connection).
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { als, type RequestContext } from '@/lib/als';
import { markSendUsedUnlessNotSent } from '@/lib/quotaUse';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

/** How the fake server answers each step; 'drop' closes the socket without a reply. */
type Step = 'auth' | 'mail' | 'rcpt' | 'data' | 'end';
let replies: Partial<Record<Step, string>> = {};
let server: Server;
let port = 0;

function smtp(socket: Socket): void {
  const say = (line: string | undefined, fallback: string) => {
    const reply = line ?? fallback;
    if (reply === 'drop') socket.destroy(); else socket.write(`${reply}\r\n`);
  };
  let inData = false;
  let buffer = '';
  socket.write('220 test ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    if (inData) {
      if (!buffer.includes('\r\n.\r\n')) return;
      inData = false; buffer = '';
      return say(replies.end, '250 queued');
    }
    let at: number;
    while ((at = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, at).toUpperCase(); buffer = buffer.slice(at + 2);
      if (line.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
      else if (line.startsWith('AUTH')) say(replies.auth, '235 ok');
      else if (line.startsWith('MAIL')) say(replies.mail, '250 ok');
      else if (line.startsWith('RCPT')) say(replies.rcpt, '250 ok');
      else if (line.startsWith('DATA')) { inData = !replies.data; say(replies.data, '354 go'); }
      else if (line.startsWith('QUIT')) { socket.write('221 bye\r\n'); socket.end(); }
    }
  });
  socket.on('error', () => undefined);
}

async function used(work: () => Promise<unknown>): Promise<number> {
  const ctx: RequestContext = {
    client: {} as RequestContext['client'], userId: 'u', claims: {},
    quotaCharges: [{ kind: 'send', key: 'send:x:co:c:day', charged: 5, used: 0, windowStart: null }],
  };
  await als.run(ctx, work);
  return ctx.quotaCharges![0]!.used;
}
const send = () => sendEmail({ to: 'a@b.co', subject: 's', html: '<p>h</p>' });

beforeAll(async () => {
  server = createServer(smtp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('sendEmail — which SMTP failures use the daily send unit (R-175)', () => {
  beforeEach(() => {
    replies = {};
    vi.stubEnv('SMTP_HOST', '127.0.0.1');
    vi.stubEnv('SMTP_PORT', String(port));
    vi.stubEnv('SMTP_USER', 'u');
    vi.stubEnv('SMTP_PASS', 'p');
  });

  it('accepted: used', async () => {
    expect(await used(async () => expect((await send()).success).toBe(true))).toBe(1);
  });

  it.each([
    ['login refused (EAUTH 535)', { auth: '535 bad credentials' }],
    ['sender refused (EENVELOPE 550 to MAIL)', { mail: '550 no' }],
    ['recipient refused (EENVELOPE 550 to RCPT)', { rcpt: '550 no such user' }],
    ['DATA refused (EENVELOPE 554 to DATA)', { data: '554 no' }],
    ['message refused at the end of DATA (EMESSAGE 554)', { end: '554 spam' }],
    ['message deferred at the end of DATA (EMESSAGE 451)', { end: '451 try later' }],
  ] as const)('%s: not used, the server said no', async (_label, r) => {
    replies = r;
    expect(await used(async () => expect((await send()).success).toBe(false))).toBe(0);
  });

  it('connection refused (ESOCKET from connect): not used', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    vi.stubEnv('SMTP_PORT', String(free));
    expect(await used(async () => expect((await send()).success).toBe(false))).toBe(0);
  });

  it('connection dropped after the message was sent, before any reply: used, the server may have it', async () => {
    replies = { end: 'drop' };
    expect(await used(async () => expect((await send()).success).toBe(false))).toBe(1);
  });

  it.each([
    ['a timeout (nodemailer uses ETIMEDOUT/CONN for connect, greeting and an idle socket mid-message)', { code: 'ETIMEDOUT', command: 'CONN' }, 1],
    ['a socket reset after connecting', { code: 'ESOCKET', syscall: 'read', command: 'CONN' }, 1],
    ['an unknown error', {}, 1],
    ['a non-error value', 'boom', 1],
    ['DNS failure (EDNS)', { code: 'EDNS', command: 'CONN' }, 0],
    ['a TLS set-up failure (ETLS)', { code: 'ETLS', command: 'STARTTLS' }, 0],
    ['no credentials (ENOAUTH)', { code: 'ENOAUTH' }, 0],
    ['a name lookup at connect (ESOCKET getaddrinfo)', { code: 'ESOCKET', syscall: 'getaddrinfo' }, 0],
    ['a connection closed with a 421 reply (ECONNECTION)', { code: 'ECONNECTION', responseCode: 421 }, 0],
  ] as const)('the classifier: %s', async (_label, shape, expected) => {
    const err = typeof shape === 'string' ? shape : Object.assign(new Error('x'), shape);
    expect(await used(async () => markSendUsedUnlessNotSent(err))).toBe(expected);
  });
});
