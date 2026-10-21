/**
 * Pool eligibility (Hein, 2026-10-21, decision 3): no bureau -> out; several bureaus -> in only when EVERY
 * linked bureau opted in. The pure rule, the loader feeding it, and the set query's shape. The set query
 * runs against a schema in tests/integration/bureau-audit-log-rls.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import {
  isCompanyPoolEligible, listPoolEligibleCompanyIds, loadCompanyPoolEligibility,
} from '@/modules/bureau/services/poolEligibility';

beforeEach(() => { sqlMock.mockReset(); process.env.MERCHANT_SHARING_ENABLED = 'true'; });
afterEach(() => { delete process.env.MERCHANT_SHARING_ENABLED; });

describe('isCompanyPoolEligible', () => {
  it('no bureau: not eligible', () => {
    expect(isCompanyPoolEligible([])).toBe(false);
  });
  it('one bureau, opted in: eligible', () => {
    expect(isCompanyPoolEligible([{ bureauId: 'b1', shareMerchantPatterns: true }])).toBe(true);
  });
  it('one bureau, not opted in: not eligible', () => {
    expect(isCompanyPoolEligible([{ bureauId: 'b1', shareMerchantPatterns: false }])).toBe(false);
  });
  it('two bureaus, one opted out: not eligible', () => {
    expect(isCompanyPoolEligible([
      { bureauId: 'b1', shareMerchantPatterns: true }, { bureauId: 'b2', shareMerchantPatterns: false },
    ])).toBe(false);
  });
  it('two bureaus, both opted in: eligible', () => {
    expect(isCompanyPoolEligible([
      { bureauId: 'b1', shareMerchantPatterns: true }, { bureauId: 'b2', shareMerchantPatterns: true },
    ])).toBe(true);
  });
});

describe('loadCompanyPoolEligibility', () => {
  it('reads the company\'s bureau links and applies the rule', async () => {
    sqlMock.mockResolvedValueOnce([
      { bureau_id: 'b1', share_merchant_patterns: true }, { bureau_id: 'b2', share_merchant_patterns: false },
    ]);
    expect(await loadCompanyPoolEligibility('co-1')).toBe(false);
    const text = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/FROM bureau_companies bc\s+JOIN bureaus b ON b\.id = bc\.bureau_id/);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual(['co-1']);
  });
  it('a company in no bureau is not eligible', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect(await loadCompanyPoolEligibility('co-1')).toBe(false);
  });
});

describe('listPoolEligibleCompanyIds', () => {
  it('groups by company over its links and keeps only every-bureau-opted-in', async () => {
    sqlMock.mockResolvedValueOnce([{ company_id: 'co-1' }]);
    expect(await listPoolEligibleCompanyIds()).toEqual(['co-1']);
    const text = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/GROUP BY bc\.company_id\s+HAVING bool_and\(b\.share_merchant_patterns\)/);
  });
});

describe('the legal-review gate off (MERCHANT_SHARING_ENABLED unset): nobody is opted in', () => {
  it.each([undefined, 'false', '1', 'TRUE'])('MERCHANT_SHARING_ENABLED=%s: a fully opted-in company is not eligible', async (v) => {
    if (v === undefined) delete process.env.MERCHANT_SHARING_ENABLED; else process.env.MERCHANT_SHARING_ENABLED = v;
    sqlMock.mockResolvedValueOnce([{ bureau_id: 'b1', share_merchant_patterns: true }]);
    expect(await loadCompanyPoolEligibility('co-1')).toBe(false);
  });
  it('the eligible set is empty without asking the database', async () => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    expect(await listPoolEligibleCompanyIds()).toEqual([]);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
