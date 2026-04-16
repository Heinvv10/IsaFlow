import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getBrandProfile, upsertBrandProfile } from '@/modules/accounting/services/afs/brandProfileService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'test-company-uuid';

const DB_ROW = {
  id: 'brand-uuid',
  company_id: COMPANY_ID,
  logo_url: 'https://cdn.example.com/logo.png',
  primary_colour: '#1a3a5c',
  secondary_colour: '#c8a86b',
  font_family: 'professional',
  cover_style: 'classic',
  report_footer_text: 'Prepared by Test Firm',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

describe('brandProfileService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('getBrandProfile', () => {
    it('returns null when no profile exists', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await getBrandProfile(COMPANY_ID);
      expect(result).toBeNull();
    });

    it('returns mapped profile when row exists', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);
      const result = await getBrandProfile(COMPANY_ID);
      expect(result).not.toBeNull();
      expect(result!.companyId).toBe(COMPANY_ID);
      expect(result!.primaryColour).toBe('#1a3a5c');
      expect(result!.fontFamily).toBe('professional');
      expect(result!.coverStyle).toBe('classic');
    });
  });

  describe('upsertBrandProfile', () => {
    it('returns the upserted profile', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);
      const result = await upsertBrandProfile(COMPANY_ID, {
        logoUrl: 'https://cdn.example.com/logo.png',
        primaryColour: '#1a3a5c',
        secondaryColour: '#c8a86b',
        fontFamily: 'professional',
        coverStyle: 'classic',
        reportFooterText: 'Prepared by Test Firm',
      });
      expect(result.id).toBe('brand-uuid');
      expect(result.primaryColour).toBe('#1a3a5c');
    });

    it('throws on invalid primary hex colour', async () => {
      await expect(
        upsertBrandProfile(COMPANY_ID, {
          logoUrl: null,
          primaryColour: 'not-a-hex',
          secondaryColour: '#ffffff',
          fontFamily: 'modern',
          coverStyle: 'minimal',
          reportFooterText: null,
        })
      ).rejects.toThrow(/Invalid hex colour/);
    });

    it('throws on invalid secondary hex colour', async () => {
      await expect(
        upsertBrandProfile(COMPANY_ID, {
          logoUrl: null,
          primaryColour: '#ffffff',
          secondaryColour: '#GGGGGG',
          fontFamily: 'bold',
          coverStyle: 'bold',
          reportFooterText: null,
        })
      ).rejects.toThrow(/Invalid hex colour/);
    });
  });
});
