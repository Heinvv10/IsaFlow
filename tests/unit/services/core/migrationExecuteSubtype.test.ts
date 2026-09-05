/**
 * The Xero/QB/Pastel wizard path: a row the operator re-typed to
 * revenue/expense without a subtype is imported under the type default, not
 * skipped — `postOpeningBalances` runs over the FULL account list and throws
 * on a code that has no gl_accounts row, so a skip here refuses the whole
 * opening trial balance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const txCalls: unknown[][] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (tx: (...a: unknown[]) => Promise<unknown[]>) => Promise<unknown>[]) => {
    const tx = async (...a: unknown[]) => { txCalls.push(a); return []; };
    await Promise.all(fn(tx));
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const postOpeningBalances = vi.fn(async () => 0);
vi.mock('@/modules/accounting/services/core/migrationOpeningBalanceService', () => ({
  postOpeningBalances: (...a: unknown[]) => postOpeningBalances(...(a as [])),
}));

import { executeMigration } from '@/modules/accounting/services/core/migrationExecuteService';
import type { ParsedAccount } from '@/modules/accounting/services/core/migrationParserService';

const CO = '11111111-1111-4111-8111-111111111111';
const row = (sourceCode: string, extra: Partial<ParsedAccount>): ParsedAccount =>
  ({ sourceCode, sourceName: sourceCode, sourceType: 'x', openingBalance: 0, ...extra });

beforeEach(() => { txCalls.length = 0; vi.clearAllMocks(); });

describe('executeMigration — income-statement rows without a subtype', () => {
  it('imports them under the type default and reports it, never skipping', async () => {
    const r = await executeMigration(CO, 'u', 'xero', [
      row('5900', { mappedType: 'expense', mappedNormalBalance: 'debit' }),
      row('5910', { mappedType: 'expense', mappedNormalBalance: 'debit', mappedSubtype: 'cost_of_sales' }),
      row('1500', { mappedType: 'asset', mappedNormalBalance: 'debit' }),
    ], [], []);
    expect(r.accountsImported).toBe(3);
    expect(r.errors).toEqual([expect.stringContaining('"5900 5900": no subtype; imported as operating_expense')]);
    const byCode = (code: string) => txCalls.find(c => c[2] === code)!;
    expect(byCode('5900')).toContain('operating_expense');
    expect(byCode('5910')).toContain('cost_of_sales');
    expect(byCode('1500')).toContain(null);
  });
});
