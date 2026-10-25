/**
 * S-07e part B (migration 946): a scan error's flip of `status` to 'error' is not
 * a scan stamp, so imapMirrorService and sentMirrorService write it on the
 * migration_admin pool, keyed on the connection and its company. If that write
 * is refused (scan-now's request transaction may hold the row), the error is
 * still recorded by a stamp-only app-pool UPDATE that does not touch status.
 * (mirrorScanError.test.ts pins the helper itself.) A scan also refuses, before
 * it connects, a host that is or resolves to private space and any port but
 * 143/993: the connection is marked errored with the reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[] }>,
  app: [] as Array<{ text: string; values: unknown[] }>,
  adminFails: false,
  connects: 0,
  resolves: ['93.184.216.34'],
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { h.connects += 1; throw new Error('connect ECONNREFUSED'); }
    async logout() { /* fake mailbox */ }
  },
}));
vi.mock('node:dns/promises', () => ({
  lookup: async () => h.resolves.map((address) => ({ address, family: 4 })),
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
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (label: string, fn: (c: unknown) => Promise<unknown>) => {
    if (h.adminFails) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    return fn({
      query: async (text: string, values: unknown[]) => {
        h.admin.push({ label, text: text.replace(/\s+/g, ' ').trim(), values });
        return { rows: [] };
      },
    });
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
});

describe.each([
  ['imap_mirror_connections', 'c1', () => scanConnection(imapConn)],
  ['sent_mirror_connections', 's1', () => scanSentConnection(sentConn)],
] as const)('%s scan error', (table, id, scan) => {
  it('writes status through migrationAdminTx, keyed on the connection and its company, nothing on the app pool', async () => {
    const r = await scan();
    expect(r.errors).toBe(1);
    expect(h.admin).toHaveLength(1);
    const w = h.admin[0]!;
    expect(w.text).toContain(`UPDATE ${table}`);
    expect(w.text).toContain("status = CASE WHEN status = 'active' THEN 'error' ELSE status END");
    expect(w.text).toContain('WHERE id = $1::uuid AND company_id = $2::uuid');
    expect(w.values).toEqual([id, COMPANY, 'connect ECONNREFUSED']);
    expect(h.app.some((q) => q.text.includes(table))).toBe(false);
  });

  it('a refused status write falls back to an app-pool stamp that never mentions status', async () => {
    h.adminFails = true;
    const r = await scan();
    expect(r.errors).toBe(1);
    const stamps = h.app.filter((q) => q.text.startsWith(`UPDATE ${table}`));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.text).toContain('SET last_scan_at = NOW(), last_error = ?');
    expect(stamps[0]!.text).toContain('WHERE id = ?::uuid AND company_id = ?::uuid');
    expect(stamps[0]!.text).not.toContain('status');
    expect(stamps[0]!.values).toEqual(['connect ECONNREFUSED', id, COMPANY]);
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
    expect(h.admin[0]!.values).toEqual([id, COMPANY, reason]);
  });

  it('a name that now resolves into private space (rebinding) is refused at scan time', async () => {
    h.resolves = ['93.184.216.34', '192.168.1.10'];
    const r = await scan({});
    expect(r.errors).toBe(1);
    expect(h.connects).toBe(0);
    expect(h.admin[0]!.values[2]).toBe('This mail server address is not allowed or could not be resolved'); // the address it resolved to stays in the log
  });

  it('a public host on an IMAP port connects (143 and 993)', async () => {
    await scan({ imapPort: 143 });
    await scan({ imapPort: 993 });
    expect(h.connects).toBe(2);
  });
});
