import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
// Mock email sending so tests don't depend on SMTP
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'mock-id' }),
}));
vi.mock('@/lib/email-templates-shared', () => ({
  emailLayout: (content: string) => `<html>${content}</html>`,
  ctaButton: (label: string, url: string) => `<a href="${url}">${label}</a>`,
}));

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
  beforeEach(() => vi.clearAllMocks());

  describe('createMagicLink', () => {
    it('returns a token string and expiresAt Date', async () => {
      mockSql
        .mockResolvedValueOnce([]) // invalidate old tokens
        .mockResolvedValueOnce([]) // insert new token
        .mockResolvedValueOnce([CONTACT_ROW]); // load contact for email
      const { token, expiresAt } = await createMagicLink(COMPANY_ID, CONTACT_ID);
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64); // 32 bytes = 64 hex chars
      expect(expiresAt).toBeInstanceOf(Date);
    });

    it('sets expiry approximately 30 minutes from now', async () => {
      mockSql
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([CONTACT_ROW]);
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
      mockSql
        .mockResolvedValueOnce([LINK_ROW])     // SELECT token
        .mockResolvedValueOnce([{ id: 'x' }])  // UPDATE used_at RETURNING id
        .mockResolvedValueOnce([CONTACT_ROW]);  // SELECT contact
      const result = await verifyMagicLink('aabbcc');
      expect(result).not.toBeNull();
      expect(result!.contact.id).toBe(CONTACT_ID);
      expect(result!.companyId).toBe(COMPANY_ID);
    });

    it('returns null for an expired or already-used token', async () => {
      mockSql.mockResolvedValueOnce([]); // no rows = expired
      const result = await verifyMagicLink('bad-token');
      expect(result).toBeNull();
    });

    it('returns null when concurrent request already consumed the token', async () => {
      mockSql
        .mockResolvedValueOnce([LINK_ROW]) // SELECT finds the token
        .mockResolvedValueOnce([]);         // UPDATE returns nothing (race)
      const result = await verifyMagicLink('aabbcc');
      expect(result).toBeNull();
    });

    it('returns null when the contact is inactive after token verification', async () => {
      mockSql
        .mockResolvedValueOnce([LINK_ROW])
        .mockResolvedValueOnce([{ id: 'x' }])
        .mockResolvedValueOnce([]); // contact not found / inactive
      const result = await verifyMagicLink('aabbcc');
      expect(result).toBeNull();
    });
  });
});
