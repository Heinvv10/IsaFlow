/**
 * WP3 server side of the list: a non-numeric amount bound is a 400 (it reached ::NUMERIC and answered 500); % and _
 * in the search are literal (escaped before the service sees them); the amount filter compares the SIZE of the line
 * (ABS) in the page query AND its count; update_notes on a missing line is a 404, not {updated:true}.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, UUID_A } from '../helpers/apiRouteCall';

const listTx = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({ getBankTransactions: (...a: unknown[]) => listTx(...a) }));

import listRoute from '../../../pages/api/accounting/bank-transactions';

beforeEach(() => { listTx.mockReset().mockResolvedValue({ transactions: [], total: 0 }); });

describe('amount bounds', () => {
  it.each(['abc', '1e5', '1e3', '12.5.1', '--3', '5 OR 1=1', 'NaN', 'Infinity', '-5', '-0.5', '-100', '1.23456'])('from_amount=%s is a 400 and nothing is queried', async (bad) => {
    for (const key of ['from_amount', 'to_amount', 'fromAmount', 'toAmount']) {
      const r = await callRoute(listRoute, { query: { bank_account_id: UUID_A, [key]: bad } });
      expect(r.code, `${key}=${bad}`).toBe(400);
    }
    expect(listTx).not.toHaveBeenCalled();
  });
  it.each(['0', '100', '.5', '.0001', '1234.56', ' 7.5 ', '0.0001'])('%j passes', async (good) => {
    expect((await callRoute(listRoute, { query: { bank_account_id: UUID_A, from_amount: good, to_amount: '9999' } })).code).toBe(200);
  });
  it('empty bounds are no bound', async () => {
    expect((await callRoute(listRoute, { query: { from_amount: '', to_amount: '' } })).code).toBe(200);
  });
});

describe('search escaping', () => {
  it.each([['50%', '50\\%'], ['a_b', 'a\\_b'], ['c:\\x', 'c:\\\\x'], ['plain', 'plain']])('%j reaches the service as %j', async (typed, escaped) => {
    await callRoute(listRoute, { query: { bank_account_id: UUID_A, search: typed } });
    expect(listTx.mock.calls.at(-1)![1]).toMatchObject({ search: escaped });
  });
});

describe('the service compares the size of the line', () => {
  it('both the page query and its COUNT use ABS(bt.amount) for the bounds, and a missing lower bound is 0', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('@/lib/neon', () => ({ sql: Object.assign(async (s: TemplateStringsArray, ...v: unknown[]) => { const text = s.join('?'); calls.push(text + '|' + v.join(',')); return text.includes('COUNT(*)') ? [{ cnt: 0 }] : []; }, { unsafe: (t: string) => t }) }));
    vi.doMock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    await getBankTransactions('co', { bankAccountId: UUID_A, status: 'imported', fromAmount: '100', toAmount: '500' });
    const withAmount = calls.filter((c) => c.includes('amount'));
    expect(withAmount.length).toBeGreaterThanOrEqual(2); // rows + count
    for (const c of withAmount.filter((q) => q.includes('>='))) {
      expect(c).toMatch(/ABS\(bt\.amount\) >= ABS\(\?::NUMERIC\) AND ABS\(bt\.amount\) <= ABS\(\?::NUMERIC\)/);
      expect(c).not.toMatch(/bt\.amount >= /);
    }
    // the search pattern is escaped text: the SQL must say which character escapes (never rely on the default)
    await getBankTransactions('co', { bankAccountId: UUID_A, status: 'imported', search: '50\\%' });
    for (const c of calls.filter((q) => q.includes('ILIKE'))) {
      expect(c).toMatch(/description ILIKE \? ESCAPE '\\' OR bt\.reference ILIKE \? ESCAPE '\\'/);
    }
    calls.length = 0;
    await getBankTransactions('co', { bankAccountId: UUID_A, status: 'imported' });
    expect(calls.some((c) => c.endsWith('|0,999999999') || c.includes(',0,999999999'))).toBe(true);
  });
});

describe('update_notes', () => {
  const noteRoute = async (found: boolean) => {
    vi.resetModules();
    vi.doMock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
    vi.doMock('@/lib/neon', () => ({ sql: Object.assign(async () => (found ? [{ status: 'imported' }] : []), { unsafe: (t: string) => t }), withSavepoint: async (_n: string, fn: () => unknown) => fn() }));
    return (await import('@/modules/accounting/services/bank/bankTxAnnotations')).updateBankTxNotes;
  };
  it('false for a line that is not this company\'s (the route turns it into a 404), true for one that is', async () => {
    expect(await (await noteRoute(false))('co', UUID_A, 'n', 'u')).toBe(false);
    expect(await (await noteRoute(true))('co', UUID_A, 'n', 'u')).toBe(true);
  });
});
