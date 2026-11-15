/**
 * S-07e part B (migration 946): no app role may write a connection row, so a scan
 * error (its stamp and the flip of `status` to 'error', one statement) is written
 * by imapMirrorService and sentMirrorService on migration_admin (routeAdminQuery),
 * keyed on the connection and its company. A refused write is logged and lost:
 * there is no app-pool fallback any more (round 5). (mirrorScanError.test.ts pins
 * the helper itself.) A scan also refuses, before
 * it connects, a host that is or resolves to private space and any port but
 * 143/993: the connection is marked errored with the reason. A transient failure (the
 * name did not resolve, the network refused or dropped the connection) is stamped with
 * status untouched, so the connection is scanned again next interval (2026-11-15).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[] }>,
  app: [] as Array<{ text: string; values: unknown[] }>,
  adminFails: false,
  connects: 0,
  resolves: ['93.184.216.34'],
  connectError: (): unknown => new Error('connect ECONNREFUSED'),
  lockError: (): unknown => new Error('no mailbox lock'),
  lookupFails: false,
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { h.connects += 1; const e = h.connectError(); if (e) throw e; }
    async getMailboxLock() { throw h.lockError(); } // after a connect that succeeded: the scan body
    async logout() { /* fake mailbox */ }
  },
}));
vi.mock('node:dns/promises', () => ({
  lookup: async () => {
    if (h.lookupFails) throw Object.assign(new Error('getaddrinfo EAI_AGAIN imap.test'), { code: 'EAI_AGAIN' });
    return h.resolves.map((address) => ({ address, family: 4 }));
  },
}));
vi.mock('mailparser', () => ({ simpleParser: async () => ({}) }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: () => 'sha', storeCapturedBytes: async () => ({ bucket: 'b', path: 'p' }) }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: () => undefined }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: async () => undefined }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.app.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return [];
  }),
  // The cron's fallback stamp: a short app-pool transaction (2 s lock_timeout, then the UPDATE).
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.app.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return [];
  })),
}));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: async (label: string, text: string, values: unknown[]) => {
    h.admin.push({ label, text: text.replace(/\s+/g, ' ').trim(), values });
    if (h.adminFails) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    return [];
  },
}));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const imapConn: MirrorConnection = {
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: {},
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true,
  imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
};
const sentConn: SentMirrorConnection = {
  id: 's1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'Sent', scanCursor: {},
  imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
};

beforeEach(() => {
  h.admin.length = 0;
  h.app.length = 0;
  h.adminFails = false;
  h.connects = 0;
  h.resolves = ['93.184.216.34'];
  h.connectError = () => new Error('connect ECONNREFUSED');
  h.lockError = () => new Error('no mailbox lock');
  h.lookupFails = false;
});

describe.each([
  ['imap_mirror_connections', 'c1', () => scanConnection(imapConn)],
  ['sent_mirror_connections', 's1', () => scanSentConnection(sentConn)],
] as const)('%s scan error', (table, id, scan) => {
  it('writes the error and the status through routeAdminQuery (migration_admin), keyed on the connection and its company, nothing on the app pool', async () => {
    const r = await scan();
    expect(r.errors).toBe(1);
    expect(h.admin).toHaveLength(1);
    const w = h.admin[0]!;
    expect(w.text).toContain(`UPDATE ${table}`);
    expect(w.text).toContain("status = CASE WHEN status = 'active' THEN 'error' ELSE status END");
    expect(w.text).toContain('WHERE id = $2::uuid AND company_id = $3::uuid');
    expect(w.values).toEqual(['connect ECONNREFUSED', id, COMPANY]);
    expect(h.app.some((q) => q.text.includes(table))).toBe(false);
  });

  it('a refused write is lost, not retried on the app pool (no app role may write the row); the scan still ends', async () => {
    h.adminFails = true;
    const r = await scan();
    expect(r.errors).toBe(1);
    expect(h.admin).toHaveLength(1);
    expect(h.app.some((q) => q.text.includes(table))).toBe(false);
  });
});

describe.each([
  ['imap_mirror_connections', 'c1', (over: object) => scanConnection({ ...imapConn, ...over })],
  ['sent_mirror_connections', 's1', (over: object) => scanSentConnection({ ...sentConn, ...over })],
] as const)('%s scan target', (table, id, scan) => {
  it.each([
    ['a loopback literal', { imapHost: '127.0.0.1' }, 'This mail server address is not allowed or could not be resolved'],
    ['a private literal', { imapHost: '10.0.0.5' }, 'This mail server address is not allowed or could not be resolved'],
    ['the metadata address', { imapHost: '169.254.169.254' }, 'This mail server address is not allowed or could not be resolved'],
    ['a port that is not IMAP', { imapPort: 6379 }, 'Only ports 143 and 993 are supported'],
  ])('%s: never connects, and the connection is marked errored with a generic reason', async (_what, over, reason) => {
    const r = await scan(over);
    expect(r.errors).toBe(1);
    expect(h.connects).toBe(0);
    expect(h.admin).toHaveLength(1);
    expect(h.admin[0]!.text).toContain(`UPDATE ${table}`);
    expect(h.admin[0]!.values).toEqual([reason, id, COMPANY]);
  });

  it('a name that now resolves into private space (rebinding) is refused at scan time', async () => {
    h.resolves = ['93.184.216.34', '192.168.1.10'];
    const r = await scan({});
    expect(r.errors).toBe(1);
    expect(h.connects).toBe(0);
    expect(h.admin[0]!.values[0]).toBe('This mail server address is not allowed or could not be resolved'); // the address it resolved to stays in the log
  });

  it('a public host on an IMAP port connects (143 and 993)', async () => {
    await scan({ imapPort: 143 });
    await scan({ imapPort: 993 });
    expect(h.connects).toBe(2);
  });
});

describe.each([
  ['imap_mirror_connections', 'c1', () => scanConnection(imapConn)],
  ['sent_mirror_connections', 's1', () => scanSentConnection(sentConn)],
] as const)('%s transient scan failure', (table, id, scan) => {
  // Counted, not flipped: the status changes only once the row's count reaches its cap (COUNT_FAILURE).
  const expectCounted = (message: string) => {
    expect(h.admin).toHaveLength(1);
    expect(h.admin[0]!.text).toMatch(new RegExp(`^UPDATE ${table} SET last_scan_at = NOW\\(\\), last_error = \\$1, consecutive_scan_failures = consecutive_scan_failures \\+ 1, status = CASE WHEN status = 'active' AND consecutive_scan_failures \\+ 1 >= `));
    expect(h.admin[0]!.values).toEqual([message, id, COMPANY]);
  };

  it('a DNS lookup that fails leaves the connection active and stamps the generic target message; never connects', async () => {
    h.lookupFails = true;
    const r = await scan();
    expect(r.errors).toBe(1);
    expect(h.connects).toBe(0);
    expectCounted('This mail server address is not allowed or could not be resolved');
  });

  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'CONNECT_TIMEOUT', 'NoConnection'])(
    'a connect that fails with %s leaves the connection active and stamps a generic message', async (code) => {
      h.connectError = () => Object.assign(new Error(`connect ${code} 93.184.216.34:993`), { code });
      const r = await scan();
      expect(r.errors).toBe(1);
      expectCounted('Mail server could not be reached; will retry');
    });

  it('a connection reset after the connect succeeded (inside the scan body) is counted the same way', async () => {
    h.connectError = () => null;
    h.lockError = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const r = await scan();
    expect(h.connects).toBe(1);
    expect(r.errors).toBe(1);
    expectCounted('Mail server could not be reached; will retry');
  });

  it('a name with no DNS answer and a name resolving into private space write the identical statement and values', async () => {
    h.lookupFails = true;
    await scan();
    h.lookupFails = false;
    h.resolves = ['10.9.8.7'];
    await scan();
    expect(h.admin).toHaveLength(2);
    expect(h.admin[1]).toEqual(h.admin[0]);
    expect(h.connects).toBe(0);
  });

  it('a rejected login after the connect (the socket then closed) is not counted: errored at once', async () => {
    h.connectError = () => Object.assign(new Error('Connection not available'), { code: 'NoConnection', authenticationFailed: true });
    const r = await scan();
    expect(r.errors).toBe(1);
    expect(h.admin[0]!.text).toContain("status = CASE WHEN status = 'active' THEN 'error' ELSE status END");
    expect(h.admin[0]!.text).not.toContain('consecutive_scan_failures');
  });

  it('a rejected login still marks the connection errored', async () => {
    h.connectError = () => Object.assign(new Error('Command failed'), { authenticationFailed: true, response: 'NO [AUTHENTICATIONFAILED]' });
    const r = await scan();
    expect(r.errors).toBe(1);
    expect(h.admin).toHaveLength(1);
    expect(h.admin[0]!.text).toContain("status = CASE WHEN status = 'active' THEN 'error' ELSE status END");
    expect(h.admin[0]!.values).toEqual(['Command failed', id, COMPANY]);
  });
});
