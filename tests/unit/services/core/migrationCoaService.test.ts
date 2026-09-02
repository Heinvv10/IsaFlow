/**
 * Migration wizard chart import — the request body used to reach gl_accounts
 * unvalidated: any accountSubtype string, and any key in systemAccountMap
 * became a flagged system account. Both now refuse before the first write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ clearSystemAccountCache: vi.fn() }));
vi.mock('@/modules/accounting/services/core/migrationService', () => ({ updateSession: vi.fn() }));

import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  importChartOfAccounts, validateSystemAccountMap,
  type AccountImportRow, type SystemAccountMap,
} from '@/modules/accounting/services/core/migrationCoaService';

const CO = '11111111-1111-4111-8111-111111111111';
const mockSql = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;
const acct = (accountCode: string, accountType: AccountImportRow['accountType'], extra: Partial<AccountImportRow> = {}): AccountImportRow =>
  ({ accountCode, accountName: accountCode, accountType, normalBalance: 'debit', ...extra });
const ACCOUNTS = [acct('1110', 'asset'), acct('1120', 'asset'), acct('2110', 'liability'), acct('1140', 'asset'),
  acct('2120', 'liability'), acct('3200', 'equity'), acct('4100', 'revenue'), acct('5100', 'expense'), acct('5400', 'expense')];
const MAP: SystemAccountMap = {
  bank: '1110', receivable: '1120', payable: '2110', vat_input: '1140', vat_output: '2120',
  retained_earnings: '3200', default_revenue: '4100', default_expense: '5100', admin_expense: '5400',
};

beforeEach(() => { vi.clearAllMocks(); mockSql.mockResolvedValue([]); });

describe('validateSystemAccountMap', () => {
  it('accepts a well-typed map', () => {
    expect(validateSystemAccountMap(MAP, ACCOUNTS)).toEqual([]);
  });
  it('refuses an unknown role, a missing code, an account not in the import, and a type that cannot carry the role', () => {
    const errors = validateSystemAccountMap(
      { ...MAP, opening_balance_equity: '3200', vat_input: '5100', payable: '', bank: '9999' }, ACCOUNTS,
    );
    expect(errors.map((e) => e.field).sort()).toEqual([
      'systemAccountMap.bank', 'systemAccountMap.opening_balance_equity', 'systemAccountMap.payable', 'systemAccountMap.vat_input',
    ]);
    expect(errors.find((e) => e.field === 'systemAccountMap.vat_input')!.message).toContain('is expense');
  });
});

describe('importChartOfAccounts', () => {
  it('refuses the whole import before any write when the map is bad', async () => {
    const r = await importChartOfAccounts(CO, 'sess', ACCOUNTS, { ...MAP, vat_input: '5100' });
    expect(r.imported).toBe(0);
    expect(r.errors[0]!.field).toBe('systemAccountMap.vat_input');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips a row whose own subtype is unknown or reserved, and imports the rest', async () => {
    const rows = [
      acct('1500', 'asset', { accountSubtype: 'Bank ' }),                 // typo → behaves like NULL downstream
      acct('1600', 'asset', { accountSubtype: 'vat_input' }),            // reserved: would sit beside the system row
      acct('1700', 'asset', { accountSubtype: 'fixed_asset' }),          // legal
    ];
    const r = await importChartOfAccounts(CO, 'sess', [...ACCOUNTS, ...rows], MAP);
    expect(r.skipped).toBe(2);
    expect(r.imported).toBe(ACCOUNTS.length + 1);
    expect(r.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('not valid'), expect.stringContaining('reserved'),
    ]);
    // Neither refused row reached an INSERT; the legal one did.
    const inserts = mockSql.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('').includes('INSERT INTO gl_accounts'));
    const codes = inserts.map((c) => c[2]);
    expect(codes).not.toContain('1500');
    expect(codes).not.toContain('1600');
    expect(inserts.find((c) => c[2] === '1700')).toContain('fixed_asset');
    expect(clearSystemAccountCache).toHaveBeenCalledWith(CO);
  });

  it('a mapped system row keeps its role even if the payload carries a different subtype', async () => {
    await importChartOfAccounts(CO, 'sess', [acct('1140', 'asset', { accountSubtype: 'other' }), ...ACCOUNTS.filter((a) => a.accountCode !== '1140')], MAP);
    const inserts = mockSql.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('').includes('INSERT INTO gl_accounts'));
    const vatRow = inserts.find((c) => c.includes('1140'))!;
    expect(vatRow).toContain('vat_input');
    expect(vatRow).toContain(true);
  });
});
