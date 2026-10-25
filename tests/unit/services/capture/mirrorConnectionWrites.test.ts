/**
 * S-07e part B (migration 946): every write to imap_mirror_connections made by
 * mirrorConnectionService runs on the migration_admin pool, bound to the verified
 * company. Re-pointing imap_host/port/tls/username would make the scan cron send
 * the stored mailbox password to an attacker's server, so no app role may.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[] }>,
  results: [] as unknown[][],
}));

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ encrypt: (p: string) => `enc(${p})` }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (label: string, fn: (c: unknown) => Promise<unknown>) => fn({
    query: async (text: string, values: unknown[]) => {
      h.admin.push({ label, text: text.replace(/\s+/g, ' ').trim(), values });
      return { rows: h.results.shift() ?? [] };
    },
  }),
}));

import { sql } from '@/lib/neon';
import {
  createImapConnection, updateConnectionSenders, disconnectConnection, reactivateConnection, deleteConnection,
} from '@/modules/accounting/services/capture/mirrorConnectionService';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const row = { id: ID, provider: 'imap', display_name: 'AP', account_email: 'ap@x.test', status: 'active', created_at: '2026-01-01' };

beforeEach(() => {
  h.admin.length = 0;
  h.results.length = 0;
  vi.mocked(sql).mockReset();
});

describe('mirrorConnectionService writes', () => {
  it('create inserts the encrypted password for the company, via migrationAdminTx', async () => {
    h.results.push([row]);
    const out = await createImapConnection({
      companyId: COMPANY, createdBy: 'u1', displayName: 'AP', accountEmail: 'ap@x.test',
      imapHost: 'imap.x.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'pw',
    });
    expect(out.id).toBe(ID);
    expect(h.admin[0]!.text).toMatch(/^INSERT INTO imap_mirror_connections/);
    expect(h.admin[0]!.values[0]).toBe(COMPANY);
    expect(h.admin[0]!.values).toContain('enc(pw)');
    expect(h.admin[0]!.values).not.toContain('pw');
    expect(sql).not.toHaveBeenCalled();
  });

  it('update changes senders, interval and folder only, keyed on id AND company; null when nothing matches', async () => {
    h.results.push([{ ...row, folder: 'AP' }], []);
    const hit = await updateConnectionSenders({ id: ID, companyId: COMPANY, allowedSenders: ['a@x.test'], folder: 'AP' });
    expect(hit?.folder).toBe('AP');
    const q = h.admin[0]!;
    expect(q.text).toContain('WHERE id = $1::uuid AND company_id = $2::uuid');
    expect(q.values.slice(0, 2)).toEqual([ID, COMPANY]);
    // The server and credential columns are never in the SET list.
    expect(q.text).not.toMatch(/imap_(host|port|use_tls|username|password_enc)|status/);
    const miss = await updateConnectionSenders({ id: ID, companyId: COMPANY, folder: 'AP' });
    expect(miss).toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });

  it('disconnect nulls the credentials, keyed on id AND company', async () => {
    h.results.push([{ id: ID }], []);
    expect(await disconnectConnection(ID, COMPANY)).toBe(true);
    expect(h.admin[0]!.text).toContain('imap_password_enc = NULL');
    expect(h.admin[0]!.text).toContain('company_id = $2::uuid');
    expect(h.admin[0]!.values).toEqual([ID, COMPANY]);
    expect(await disconnectConnection(ID, COMPANY)).toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it('reactivate and delete are keyed on id AND company', async () => {
    h.results.push([{ id: ID }], [{ id: ID }]);
    expect(await reactivateConnection(ID, COMPANY)).toBe(true);
    expect(await deleteConnection(ID, COMPANY)).toBe(true);
    expect(h.admin[0]!.text).toContain("SET status = 'active'");
    expect(h.admin[0]!.text).toContain('WHERE id = $1::uuid AND company_id = $2::uuid');
    expect(h.admin[1]!.text).toMatch(/^DELETE FROM imap_mirror_connections WHERE id = \$1::uuid AND company_id = \$2::uuid/);
    for (const q of h.admin) expect(q.values).toEqual([ID, COMPANY]);
    expect(sql).not.toHaveBeenCalled();
  });
});
