import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { executeDataQueries, isZeroBalance } from '@/modules/accounting/services/afs/noteDataQueryService';

const COMPANY_ID = 'ccc11111-0000-0000-0000-000000000001';
const FISCAL_YEAR = 2025;

describe('noteDataQueryService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('executeDataQueries', () => {
    it('returns empty object when dataQueries is empty', async () => {
      const result = await executeDataQueries(COMPANY_ID, FISCAL_YEAR, {});
      expect(result).toEqual({});
    });

    it('returns keyed result set for each query name', async () => {
      const result = await executeDataQueries(COMPANY_ID, FISCAL_YEAR, {
        ppe: 'SELECT * FROM assets',
        receivables: 'SELECT * FROM customer_invoices',
      });
      expect(Object.keys(result)).toContain('ppe');
      expect(Object.keys(result)).toContain('receivables');
    });

    it('returns arrays as values', async () => {
      const result = await executeDataQueries(COMPANY_ID, FISCAL_YEAR, { q1: 'SELECT 1' });
      expect(Array.isArray(result.q1)).toBe(true);
    });
  });

  describe('isZeroBalance', () => {
    it('returns true when snapshot is empty object', () => {
      expect(isZeroBalance({})).toBe(true);
    });

    it('returns true when all arrays are empty', () => {
      expect(isZeroBalance({ ppe: [], receivables: [] })).toBe(true);
    });

    it('returns false when any array has rows', () => {
      expect(isZeroBalance({ ppe: [{ id: 1 }], receivables: [] })).toBe(false);
    });

    it('returns false when all arrays have rows', () => {
      expect(isZeroBalance({ ppe: [{ id: 1 }], receivables: [{ id: 2 }] })).toBe(false);
    });
  });
});
