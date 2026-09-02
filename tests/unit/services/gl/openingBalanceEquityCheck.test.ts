import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
import { sql } from '@/lib/neon';
import { openingBalanceEquityCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/openingBalanceEquityCheck';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const mockSql = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;
const run = () => openingBalanceEquityCheck(COMPANY, { endDate: '2026-03-31' });

beforeEach(() => vi.clearAllMocks());

describe('openingBalanceEquityCheck', () => {
  it('passes when the company has no such account', async () => {
    mockSql.mockResolvedValueOnce([{ accounts: '0', balance: '0' }]);
    expect(await run()).toMatchObject({ key: 'opening_balance_cleared', status: 'pass', reason: expect.stringContaining('No opening') });
  });
  it('passes when the balance nets to zero within a cent', async () => {
    mockSql.mockResolvedValueOnce([{ accounts: '1', balance: '0.004' }]);
    expect((await run()).status).toBe('pass');
  });
  it('WARNS (never fails) on a residual and names the amount', async () => {
    mockSql.mockResolvedValueOnce([{ accounts: '1', balance: '-12500.5' }]);
    const r = await run();
    expect(r.status).toBe('warn');
    expect(r.reason).toContain('R-12500.50');
  });
  it('scopes by company_id on every table and cuts at period end', async () => {
    mockSql.mockResolvedValueOnce([{ accounts: '0', balance: '0' }]);
    await run();
    const text = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text.match(/company_id = \?::UUID/g)).toHaveLength(3);
    expect(text).toContain("je.status = 'posted'");
    // Only the system account counts — a stray non-system row carrying the
    // subtype (the migration import path does not run subtypeErrorFor) must
    // not pollute the residual.
    expect(text).toContain('ga.is_system_account = true');
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([COMPANY, COMPANY, '2026-03-31', COMPANY, 'opening_balance_equity']);
  });
});
