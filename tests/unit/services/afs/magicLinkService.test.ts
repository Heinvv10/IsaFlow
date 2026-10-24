import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
// S-07d (migration 935): portal_magic_links reads/writes run on the migration_admin
// pool; the fake client feeds adminMock. The contact lookup stays on sql.
const adminMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: (_label: string, fn: (c: unknown) => unknown) =>
    fn({ query: async (t: string, p?: unknown[]) => ({ rows: await adminMock(t, p) }) }),
}));
const liveMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/liveCompanies', () => ({ listLiveCompanies: liveMock }));

import { sql } from '@/lib/neon';
import { createMagicLink, verifyMagicLink } from '@/modules/accounting/services/afs/magicLinkService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const CONTACT_ID = 'c1c1c1c1-0000-0000-0000-000000000001';

const CONTACT_ROW = {
  id: CONTACT_ID,
  company_id: COMPANY_ID,
  name: 'Alice Director',
  email: 'alice@example.com',
  role: 'director',
  active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

const LINK_ROW = {
  id: 'link-id-1',
  company_id: COMPANY_ID,
  contact_id: CONTACT_ID,
  token: 'aabbcc',
  expires_at: new Date(Date.now() + 15 * 60 * 1000),
  used_at: null,
  created_at: new Date(),
};

describe('magicLinkService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    liveMock.mockResolvedValue([{ companyId: COMPANY_ID, companyName: 'Acme' }]);
  });

  describe('createMagicLink', () => {
    it('returns a token string and expiresAt Date', async () => {
      adminMock
        .mockResolvedValueOnce([]) // invalidate old tokens
        .mockResolvedValueOnce([]); // insert new token
      const { token, expiresAt } = await createMagicLink(COMPANY_ID, CONTACT_ID);
      expect(adminMock.mock.calls[0]![0]).toContain('UPDATE portal_magic_links');
      expect(adminMock.mock.calls[0]![1]).toEqual([CONTACT_ID, COMPANY_ID]);
      expect(adminMock.mock.calls[1]![0]).toContain('INSERT INTO portal_magic_links');
      expect(adminMock.mock.calls[1]![1]).toContain(token);
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64); // 32 bytes = 64 hex chars
      expect(expiresAt).toBeInstanceOf(Date);
    });

    it('sets expiry approximately 30 minutes from now', async () => {
      adminMock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const before = Date.now();
      const { expiresAt } = await createMagicLink(COMPANY_ID, CONTACT_ID);
      const after = Date.now();
      const diffMs = expiresAt.getTime() - before;
      expect(diffMs).toBeGreaterThan(29 * 60 * 1000);
      // Allow 1 second buffer for execution time
      expect(diffMs).toBeLessThan(30 * 60 * 1000 + (after - before) + 1000);
    });
  });

  describe('verifyMagicLink', () => {
    it('returns contact and companyId for a valid unused token', async () => {
      adminMock
        .mockResolvedValueOnce([LINK_ROW])     // SELECT token
        .mockResolvedValueOnce([{ id: 'x' }]); // UPDATE used_at RETURNING id
      mockSql.mockResolvedValueOnce([CONTACT_ROW]); // SELECT contact
      const result = await verifyMagicLink('aabbcc');
      expect(result).not.toBeNull();
      expect(result!.contact.id).toBe(CONTACT_ID);
      expect(result!.companyId).toBe(COMPANY_ID);
    });

    it('returns null, without consuming the token, when the company is no longer live', async () => {
      liveMock.mockResolvedValue([]);
      adminMock.mockResolvedValueOnce([LINK_ROW]);
      const result = await verifyMagicLink('aabbcc');
      expect(result).toBeNull();
      expect(liveMock).toHaveBeenCalledWith([COMPANY_ID]);
      expect(adminMock).toHaveBeenCalledTimes(1); // the SELECT only: no consuming UPDATE
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('returns null for an expired or already-used token', async () => {
      adminMock.mockResolvedValueOnce([]); // no rows = expired
      const result = await verifyMagicLink('bad-token');
      expect(result).toBeNull();
    });

    it('returns null when concurrent request already consumed the token', async () => {
      adminMock
        .mockResolvedValueOnce([LINK_ROW]) // SELECT finds the token
        .mockResolvedValueOnce([]);         // UPDATE returns nothing (race)
      const result = await verifyMagicLink('aabbcc');
      expect(result).toBeNull();
    });

    it('returns null when the contact is inactive after token verification', async () => {
      adminMock
        .mockResolvedValueOnce([LINK_ROW])
        .mockResolvedValueOnce([{ id: 'x' }]);
      mockSql.mockResolvedValueOnce([]); // contact not found / inactive
      const result = await verifyMagicLink('aabbcc');
      expect(result).toBeNull();
    });
  });
});
