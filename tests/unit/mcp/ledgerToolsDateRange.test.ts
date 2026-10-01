/**
 * Security round 3 (PR #595): `isRealCalendarDate` accepts years 1-9999, so an MCP ledger
 * tool given 0001-01-01 floored the fiscal year to 0000-03-01 and bound it as ::date — a
 * Postgres 22008 that poisons the request transaction. The handler is the only validation
 * (inputSchema is not enforced at runtime), so both tools must refuse before any service call.
 */
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

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;

const tools = [
  ['general_ledger', generalLedgerTool, getGeneralLedgerLines, (a: string, b: string) => ({ period_start: a, period_end: b })],
  ['search_gl', searchGlTool, getAccountLedger, (a: string, b: string) => ({ account_code: '5200', from_date: a, to_date: b })],
] as const;

const BAD = ['0001-01-01', '0099-12-31', '1899-12-31', '2201-01-01', '9999-12-31'];

describe.each(tools)('%s refuses a non-ledger year before any service call', (_n, tool, service, args) => {
  beforeEach(() => { vi.mocked(service).mockClear(); });

  it.each(BAD)('%s as start', async (bad) => {
    const r = await tool.handler(args(bad, '2026-09-30'), CTX);
    expect(r.isError).toBe(true);
    expect(service).not.toHaveBeenCalled();
  }, 5000);

  it.each(BAD)('%s as end', async (bad) => {
    const r = await tool.handler(args('2026-01-01', bad), CTX);
    expect(r.isError).toBe(true);
    expect(service).not.toHaveBeenCalled();
  }, 5000);

  it('lets the legal edge 1900-01-01 through to the service', async () => {
    await expect(tool.handler(args('1900-01-01', '2026-09-30'), CTX)).rejects.toThrow('service reached');
    expect(service).toHaveBeenCalledTimes(1);
  }, 5000);
});
