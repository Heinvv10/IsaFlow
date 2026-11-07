/**
 * A customer's default revenue account (migration 966): which account it may be, and that a refusal comes before the
 * create or update writes anything (a 4xx commits the request's transaction, so a write before the check would stick).
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }), withTransaction: vi.fn(), withSavepoint: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  customerRevenueAccount, customerRevenueAccountForUpdate, customerRevenueAccountProblem, describeCustomerRevenueAccount,
} from '@/modules/accounting/services/core/contactRevenueAccount';
import { ContactValidationError } from '@/modules/accounting/services/core/contactValidationError';
import { createCustomer, updateCustomer } from '@/modules/accounting/services/core/customerWriteService';
import { customerInputFromBody, customerPatchFromBody } from '@/modules/accounting/services/core/contactRequestInput';
import { customerInput } from '@/lib/mcp/tools/contactToolFields';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const ID = 'dddddddd-0000-4000-8000-dddddddddddd';
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';

const row = (over: Partial<{ account_code: string; account_name: string; account_type: string; is_active: boolean; has_children: boolean }> = {}) => ({
  account_code: '4000', account_name: 'Sales', account_type: 'revenue', is_active: true, has_children: false, ...over,
});
const sqlText = (call: unknown[]) => (call[0] as string[]).join('?');

beforeEach(() => { vi.clearAllMocks(); mockSql.mockResolvedValue([{ id: ID, name: 'X' }]); });

describe('customerRevenueAccountProblem', () => {
  it('accepts an active leaf revenue account that can carry VAT', () => {
    expect(customerRevenueAccountProblem(row())).toBeNull();
  });
  it.each([
    [row({ account_type: 'expense' }), 'is not a revenue account (it is expense)'],
    [row({ is_active: false }), 'is inactive'],
    [row({ has_children: true }), 'is a header account with sub-accounts; choose one of those'],
    [row({ account_name: 'Interest Received' }), 'can never carry VAT (exempt financial service)'],
    [row({ account_name: 'Dividends Received' }), 'can never carry VAT (owner distribution)'],
  ])('refuses %j', (account, problem) => {
    expect(customerRevenueAccountProblem(account)).toBe(problem);
  });
});

describe('customerRevenueAccount', () => {
  it.each([undefined, null, '', '   '])('%j is none, and asks the database nothing', async (v) => {
    await expect(customerRevenueAccount(COMPANY, v)).resolves.toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });
  it('refuses a value that is not an id without asking the database', async () => {
    await expect(customerRevenueAccount(COMPANY, 'sales')).rejects.toThrow('default_revenue_account_id must be a GL account id');
    expect(mockSql).not.toHaveBeenCalled();
  });
  it('reads the account in THIS company only, and refuses one it does not find, naming the id', async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(customerRevenueAccount(COMPANY, ACCOUNT)).rejects.toThrow(`default_revenue_account_id ${ACCOUNT} is not one of this company's accounts`);
    expect(sqlText(mockSql.mock.calls[0]!)).toMatch(/a\.company_id = \?::UUID/);
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([ACCOUNT, COMPANY]);
  });
  it('refuses a deactivated account, naming it', async () => {
    mockSql.mockResolvedValueOnce([row({ is_active: false })]);
    await expect(customerRevenueAccount(COMPANY, ACCOUNT)).rejects.toThrow(
      "4000 Sales cannot be a customer's default revenue account: it is inactive");
  });
  it('returns the id of an account it accepts', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    await expect(customerRevenueAccount(COMPANY, ` ${ACCOUNT} `)).resolves.toBe(ACCOUNT);
  });
});

describe('the write services judge the account before they write', () => {
  it('create: a refused account runs no INSERT', async () => {
    mockSql.mockResolvedValueOnce([row({ account_type: 'asset', account_code: '1000', account_name: 'Bank' })]);
    await expect(createCustomer(COMPANY, { name: 'A', defaultRevenueAccountId: ACCOUNT })).rejects.toThrow(ContactValidationError);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(sqlText(mockSql.mock.calls[0]!)).not.toMatch(/INSERT/);
  });
  it('update: a refused account runs no UPDATE', async () => {
    mockSql.mockResolvedValueOnce([{ default_revenue_account_id: null }]); // the stored value: none
    mockSql.mockResolvedValueOnce([]); // the account lookup finds nothing
    await expect(updateCustomer(COMPANY, ID, { defaultRevenueAccountId: ACCOUNT })).rejects.toThrow('not one of this company');
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockSql.mock.calls.map(sqlText).join('\n')).not.toMatch(/UPDATE/);
  });
  it('update: the value already stored is not judged again (a deactivated default does not block other edits)', async () => {
    mockSql.mockResolvedValueOnce([{ default_revenue_account_id: ACCOUNT.toUpperCase() }]);
    await updateCustomer(COMPANY, ID, { phone: '011', defaultRevenueAccountId: ACCOUNT });
    expect(mockSql).toHaveBeenCalledTimes(2); // the stored value, then the UPDATE: no account lookup
    expect(sqlText(mockSql.mock.calls[0]!)).toMatch(/FROM customers WHERE id = \?::UUID AND company_id = \?::UUID/);
    expect(sqlText(mockSql.mock.calls[1]!)).toMatch(/UPDATE customers/);
  });
  it('create stores the accepted account; update sets it, or clears it when asked', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    await createCustomer(COMPANY, { name: 'A', defaultRevenueAccountId: ACCOUNT });
    expect(sqlText(mockSql.mock.calls[1]!)).toContain('default_revenue_account_id');
    expect(mockSql.mock.calls[1]!.slice(1)).toContain(ACCOUNT);

    mockSql.mockClear();
    await updateCustomer(COMPANY, ID, { defaultRevenueAccountId: '', clear: ['defaultRevenueAccountId'] });
    expect(mockSql).toHaveBeenCalledTimes(1); // nothing to judge
    expect(sqlText(mockSql.mock.calls[0]!)).toMatch(/default_revenue_account_id = CASE WHEN \? THEN NULL/);
    expect(mockSql.mock.calls[0]!.slice(1)).toContain(true);
  });
});

describe('every way in carries the field', () => {
  it('the REST body: create reads it, an edit sending it blank clears it', () => {
    expect(customerInputFromBody({ default_revenue_account_id: ACCOUNT }).defaultRevenueAccountId).toBe(ACCOUNT);
    expect(customerPatchFromBody({ default_revenue_account_id: '' }).clear).toContain('defaultRevenueAccountId');
    expect(customerPatchFromBody({ name: 'X' }).clear).not.toContain('defaultRevenueAccountId');
  });
  it('the MCP create_customer / update_customer arguments; an empty value is ignored and MCP never clears', () => {
    expect(customerInput({ default_revenue_account_id: ACCOUNT }).defaultRevenueAccountId).toBe(ACCOUNT);
    const blank = customerInput({ default_revenue_account_id: '' });
    expect(blank.defaultRevenueAccountId).toBeUndefined();
    expect(blank).not.toHaveProperty('clear');
  });
});

describe('customerRevenueAccountForUpdate / describeCustomerRevenueAccount', () => {
  it('a changed value is judged as on create', async () => {
    mockSql.mockResolvedValueOnce([{ default_revenue_account_id: 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee' }]);
    mockSql.mockResolvedValueOnce([row({ is_active: false })]);
    await expect(customerRevenueAccountForUpdate(COMPANY, ID, ACCOUNT)).rejects.toThrow('it is inactive');
  });
  it('describes a stored account, usable or not, and nothing for none', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    await expect(describeCustomerRevenueAccount(COMPANY, ACCOUNT)).resolves.toEqual({ id: ACCOUNT, label: '4000 · Sales', usable: true, problem: null });
    mockSql.mockResolvedValueOnce([row({ is_active: false })]);
    await expect(describeCustomerRevenueAccount(COMPANY, ACCOUNT)).resolves.toMatchObject({ usable: false, problem: 'is inactive' });
    await expect(describeCustomerRevenueAccount(COMPANY, null)).resolves.toBeNull();
  });
});
