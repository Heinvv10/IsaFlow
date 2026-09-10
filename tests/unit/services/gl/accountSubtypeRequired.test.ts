/**
 * Revenue and expense accounts must carry a subtype at creation.
 *
 * The income statement bands on `account_subtype`: `cost_of_sales` sits
 * above gross profit, everything else below it, and NULL is silently
 * "everything else". Velocity Fibre's Sage import wrote 77 revenue/expense
 * accounts with no subtype at all, so R82.7m of direct costs sat under
 * operating expenses and gross margin read 96.6% instead of about −1.9%.
 * Nothing on any create path refused the blank — this file is that refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/cache', () => ({ cache: { invalidatePrefix: vi.fn() }, cacheThrough: vi.fn() }));

import { sql } from '@/lib/neon';
import { missingSubtypeError, defaultIncomeStatementSubtype } from '@/modules/accounting/services/gl/accountSubtypeRules';
import { SYSTEM_RESERVED_SUBTYPES } from '@/modules/accounting/types/glAccountSubtypes';
import { autoMapAccounts, type ParsedAccount } from '@/modules/accounting/services/core/migrationParserService';
import { createAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { getTemplateLines } from '@/modules/accounting/services/gl/chartOfAccountsImportService';

const CO = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { vi.clearAllMocks(); });

describe('missingSubtypeError', () => {
  it('refuses a blank subtype on revenue and expense accounts', () => {
    expect(missingSubtypeError('expense', undefined)).toContain('required');
    expect(missingSubtypeError('expense', '')).toContain('required');
    expect(missingSubtypeError('revenue', null)).toContain('required');
  });
  it('allows a blank subtype on balance-sheet accounts', () => {
    expect(missingSubtypeError('asset', undefined)).toBeNull();
    expect(missingSubtypeError('liability', '')).toBeNull();
    expect(missingSubtypeError('equity', null)).toBeNull();
  });
  it('lists only subtypes the next call would accept', () => {
    const msg = missingSubtypeError('revenue', undefined)!;
    const listed = msg.slice(msg.indexOf('Valid: ') + 7).split(', ');
    expect(listed).toEqual(['revenue', 'other']);
    for (const s of listed) expect(SYSTEM_RESERVED_SUBTYPES).not.toContain(s);
  });
  it('is satisfied by any present value — validity is subtypeErrorFor’s job', () => {
    expect(missingSubtypeError('expense', 'cost_of_sales')).toBeNull();
    expect(missingSubtypeError('revenue', 'revenue')).toBeNull();
  });
});

describe('createAccount', () => {
  it('refuses unissued account creation before SQL; actual subtype enforcement has issued PG coverage', async () => {
    await expect(createAccount(CO, {
      accountCode: '5999', accountName: 'Sundry', accountType: 'expense', normalBalance: 'debit',
    })).rejects.toThrow('Authenticated control transaction required');
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('defaultIncomeStatementSubtype', () => {
  it('gives bulk imports an explicit, reclassifiable value instead of NULL', () => {
    expect(defaultIncomeStatementSubtype('revenue')).toBe('revenue');
    expect(defaultIncomeStatementSubtype('expense')).toBe('operating_expense');
    expect(defaultIncomeStatementSubtype('asset')).toBeNull();
  });
});

describe('autoMapAccounts', () => {
  const parsed = (sourceType: string, sourceCode = 'X1'): ParsedAccount =>
    ({ sourceCode, sourceName: sourceType, sourceType, openingBalance: 0 });
  it('sets a subtype on every income-statement mapping, for every source', () => {
    const xero = autoMapAccounts('xero', [parsed('DIRECTCOSTS'), parsed('EXPENSE'), parsed('REVENUE'), parsed('OTHERINCOME')]);
    expect(xero.map(a => a.mappedSubtype)).toEqual(['cost_of_sales', 'operating_expense', 'revenue', 'revenue']);
    const qb = autoMapAccounts('quickbooks', [parsed('Cost of Goods Sold'), parsed('Expense'), parsed('Income')]);
    expect(qb.map(a => a.mappedSubtype)).toEqual(['cost_of_sales', 'operating_expense', 'revenue']);
    // 4-digit and 7-digit (Sage 50) Pastel codes must type the same way.
    const pastel = autoMapAccounts('pastel', [parsed('?', '4100'), parsed('?', '6200'), parsed('?', '4100000'), parsed('?', '1110000')]);
    expect(pastel.map(a => [a.mappedType, a.mappedSubtype])).toEqual([
      ['revenue', 'revenue'], ['expense', 'operating_expense'], ['revenue', 'revenue'], ['asset', undefined],
    ]);
    for (const a of [...xero, ...qb, ...pastel]) {
      expect(missingSubtypeError(a.mappedType!, a.mappedSubtype)).toBeNull();
    }
  });
});

describe('chart templates', () => {
  it('seed every revenue and expense line with a subtype', () => {
    for (const template of ['isaflow_standard', 'xero_compatible', 'sage_compatible'] as const) {
      const bare = getTemplateLines(template)
        .filter(l => (l.type === 'revenue' || l.type === 'expense') && !l.subtype)
        .map(l => `${template}:${l.code}`);
      expect(bare).toEqual([]);
      // A reserved subtype belongs to the system row auto-posting resolves;
      // seeding it on a plain row is state the app's own gate refuses to write.
      const reservedOnPlainRows = getTemplateLines(template)
        .filter(l => !l.isSystem && l.subtype && SYSTEM_RESERVED_SUBTYPES.includes(l.subtype as never))
        .map(l => `${template}:${l.code}`);
      expect(reservedOnPlainRows).toEqual([]);
    }
  });
});
