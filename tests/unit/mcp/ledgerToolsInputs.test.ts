/** Round 4 (breaker T3/T4/T2): a cursor part Postgres cannot cast, and an inverted range, are tool errors before any service call. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/generalLedgerStreamService', () => ({
  getGeneralLedgerLines: vi.fn(async () => { throw new Error('service reached'); }),
}));
vi.mock('@/modules/accounting/services/reports/accountLedgerService', () => ({
  getAccountLedger: vi.fn(async () => { throw new Error('service reached'); }),
}));

import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { generalLedgerTool } from '@/lib/mcp/tools/generalLedger';
import { searchGlTool } from '@/lib/mcp/tools/reports';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = { userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111', scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const cursor = (parts: unknown[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
const GOOD = ['5000', '2026-04-10', '2026-04-10 08:00:00.123456', '00000000-0000-4000-8000-000000000001'];
const base = { period_start: '2026-03-01', period_end: '2026-09-30' };

beforeEach(() => { vi.mocked(getGeneralLedgerLines).mockClear(); vi.mocked(getAccountLedger).mockClear(); });

describe('general_ledger cursor parts are validated before any query', () => {
  it.each([
    ['junk date', ['5000', 'junk', GOOD[2], GOOD[3]]],
    ['impossible date', ['5000', '2026-02-31', GOOD[2], GOOD[3]]],
    ['year 0001', ['5000', '0001-01-01', GOOD[2], GOOD[3]]],
    ['junk created key', ['5000', GOOD[1], 'yesterday', GOOD[3]]],
    ['junk line id', ['5000', GOOD[1], GOOD[2], 'not-a-uuid']],
    ['non-string part', ['5000', 20260410, GOOD[2], GOOD[3]]],
  ])('%s', async (_n, parts) => {
    const r = await generalLedgerTool.handler({ ...base, cursor: cursor(parts) }, CTX);
    expect(r.isError).toBe(true);
    expect(getGeneralLedgerLines).not.toHaveBeenCalled();
  }, 5000);

  it('a well-formed cursor reaches the service', async () => {
    await expect(generalLedgerTool.handler({ ...base, cursor: cursor(GOOD) }, CTX)).rejects.toThrow('service reached');
  }, 5000);
});

describe('an inverted range is a tool error', () => {
  it('general_ledger', async () => {
    const r = await generalLedgerTool.handler({ period_start: '2026-09-30', period_end: '2026-03-01' }, CTX);
    expect(r.isError).toBe(true);
    expect(getGeneralLedgerLines).not.toHaveBeenCalled();
  }, 5000);
  it('search_gl', async () => {
    const r = await searchGlTool.handler({ account_code: '5000', from_date: '2026-09-30', to_date: '2026-03-05' }, CTX);
    expect(r.isError).toBe(true);
    expect(getAccountLedger).not.toHaveBeenCalled();
  }, 5000);
});
