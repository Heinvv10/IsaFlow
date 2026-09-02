/**
 * ensureOpeningBalanceEquityAccount — find-or-create of the clearing account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/cache', () => ({ cache: { invalidatePrefix: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ clearSystemAccountCache: vi.fn() }));

import { sql } from '@/lib/neon';
import { cache } from '@/lib/cache';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { ensureOpeningBalanceEquityAccount } from '@/modules/accounting/services/gl/openingBalanceEquityService';
import { GL_ACCOUNT_SUBTYPES_BY_TYPE, SYSTEM_RESERVED_SUBTYPES } from '@/modules/accounting/types/glAccountSubtypes';
import { subtypeErrorFor } from '@/modules/accounting/services/gl/accountSubtypeRules';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const mockSql = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;
const textOf = (call: number) => (mockSql.mock.calls[call]![0] as TemplateStringsArray).join('?');

beforeEach(() => vi.clearAllMocks());

describe('ensureOpeningBalanceEquityAccount', () => {
  it('returns the existing system account without writing', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'obe', account_code: '3300', account_name: 'Opening Balance Equity' }]);
    const r = await ensureOpeningBalanceEquityAccount(COMPANY);
    expect(r).toEqual({ id: 'obe', accountCode: '3300', accountName: 'Opening Balance Equity', created: false });
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(textOf(0)).toContain('is_system_account = true');
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY);
  });

  it('creates 3300 under the 3000 equity header on first use and busts both caches', async () => {
    mockSql
      .mockResolvedValueOnce([])                                   // no existing
      .mockResolvedValueOnce([])                                   // no codes taken
      .mockResolvedValueOnce([{ id: 'hdr', level: 1 }])            // 3000 header
      .mockResolvedValueOnce([{ id: 'new', account_code: '3300', account_name: 'Opening Balance Equity' }]);
    const r = await ensureOpeningBalanceEquityAccount(COMPANY);
    expect(r).toMatchObject({ id: 'new', accountCode: '3300', created: true });
    const insert = mockSql.mock.calls[3]!;
    expect(textOf(3)).toContain('INSERT INTO gl_accounts');
    expect(insert.slice(1)).toEqual(expect.arrayContaining([COMPANY, '3300', 'opening_balance_equity', 2, 'hdr']));
    expect(cache.invalidatePrefix).toHaveBeenCalledWith(`${COMPANY}:gl-accounts`);
    expect(clearSystemAccountCache).toHaveBeenCalledWith(COMPANY);
  });

  it('skips a taken code and creates at level 1 with no parent when there is no 3000 header', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ account_code: '3300' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'new', account_code: '3310', account_name: 'Opening Balance Equity' }]);
    await ensureOpeningBalanceEquityAccount(COMPANY);
    expect(mockSql.mock.calls[3]!.slice(1)).toEqual(expect.arrayContaining(['3310', 1, null]));
  });

  it('refuses rather than inventing a code when every preferred code is taken', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['3300', '3310', '3320', '3390'].map((c) => ({ account_code: c })));
    await expect(ensureOpeningBalanceEquityAccount(COMPANY)).rejects.toThrow('No free account code');
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});

describe('opening_balance_equity subtype registration', () => {
  it('is a legal equity subtype but reserved — a user account cannot be moved onto it', () => {
    expect(GL_ACCOUNT_SUBTYPES_BY_TYPE.equity).toContain('opening_balance_equity');
    expect(SYSTEM_RESERVED_SUBTYPES).toContain('opening_balance_equity');
    expect(subtypeErrorFor({ accountType: 'equity' }, 'opening_balance_equity')).toMatch(/reserved/);
    expect(subtypeErrorFor({ accountType: 'equity', currentSubtype: 'opening_balance_equity' }, 'opening_balance_equity')).toBeNull();
  });
});
