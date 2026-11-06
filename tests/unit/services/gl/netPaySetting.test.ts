/**
 * The one parser of the stored `payroll_net_pay` row, shared by the payroll plan's resolver and the account-merge
 * guard. A row it cannot read is NEVER "not set": the company may have chosen a clearing account, and reading its
 * row as empty would credit the bank and count net pay twice.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_UUID_PATTERN, DEFAULT_ACCOUNTS_SETTINGS_KEY, PAYROLL_NET_PAY_KEY, parseNetPayAccountId,
} from '@/modules/accounting/services/gl/netPaySetting';

const ID = '21700000-0000-4000-8000-000000000001';
const row = { [PAYROLL_NET_PAY_KEY]: ID, sales_discount: 'x' };

describe('parseNetPayAccountId', () => {
  it('names the key and the row (the strings every module imports instead of retyping)', () => {
    expect(DEFAULT_ACCOUNTS_SETTINGS_KEY).toBe('accounting_default_accounts');
    expect(PAYROLL_NET_PAY_KEY).toBe('payroll_net_pay');
    expect(ACCOUNT_UUID_PATTERN.test(ID)).toBe(true);
    expect(ACCOUNT_UUID_PATTERN.test('not-a-uuid')).toBe(false);
  });

  it.each([
    ['an object', row],
    ['JSON text of an object', JSON.stringify(row)],
    ['JSON text of a JSON string (written twice)', JSON.stringify(JSON.stringify(row))],
  ])('reads %s', (_name, raw) => {
    expect(parseNetPayAccountId(raw)).toEqual({ ok: true, accountId: ID });
  });

  it.each([
    ['no row', undefined],
    ['a NULL value', null],
    ['an empty string', ''],
    ['JSON null', 'null'],
    ['an object without the key', { sales_discount: 'x' }],
    ['the key null', { [PAYROLL_NET_PAY_KEY]: null }],
    ['the key an empty string', { [PAYROLL_NET_PAY_KEY]: '' }],
    ['JSON text of an object without the key', JSON.stringify({ sales_discount: 'x' })],
  ])('reads %s as not set', (_name, raw) => {
    expect(parseNetPayAccountId(raw)).toEqual({ ok: true, accountId: null });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a plain word', 'ZAR'],
    ['a number', 42],
    ['a boolean', true],
    ['a list', [ID]],
    ['JSON text of a list', JSON.stringify([ID])],
    ['JSON text of a number', '7'],
    ['text written three times', JSON.stringify(JSON.stringify(JSON.stringify(row)))],
    ['a numeric net pay', { [PAYROLL_NET_PAY_KEY]: 7 }],
    ['an object net pay', { [PAYROLL_NET_PAY_KEY]: { id: ID } }],
  ])('refuses to read %s (not "not set")', (_name, raw) => {
    const read = parseNetPayAccountId(raw);
    expect(read.ok).toBe(false);
    expect(read).toMatchObject({ reason: expect.any(String) });
  });
});
