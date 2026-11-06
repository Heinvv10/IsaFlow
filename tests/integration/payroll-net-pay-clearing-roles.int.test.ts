/**
 * With `payroll_net_pay` unset, payroll credits net pay to the BANK-role holder, so the Default Accounts row that moves
 * the bank role (`primary_bank`) redirects net pay just as `payroll_net_pay` does. Both are owner/admin only: a manager
 * (who can approve payroll) gets a 403 for either key, and nothing is saved. An owner's or admin's move of the bank role
 * is audited with the old and new account id and code. Real route (withAuth, app_user, RLS); disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let bank1110 = '';
let bank1120 = '';
let manager = '';

const save = (mappings: Record<string, unknown>, loaded: Record<string, unknown>, user?: string) =>
  r.call(defaultAccounts as Route, 'POST', '/api/accounting/default-accounts', undefined, { body: { mappings, loaded }, user });
const bankHolder = async (): Promise<string> => (await r.pool.query(
  `SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'bank' AND is_system_account`, [r.company])).rows[0]!.account_code;
const audits = async () => (await r.pool.query(
  `SELECT user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'default_accounts' ORDER BY created_at, id`, [r.company])).rows;

beforeAll(async () => {
  r = await rig('net-pay-roles');
  await r.setup(); // 1110 holds the bank role
  bank1110 = (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '1110'`, [r.company])).rows[0]!.id;
  bank1120 = (await r.pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_system_account)
     VALUES ($1, '1120', 'NPR 1120', 'asset', 'debit', 1, false) RETURNING id`, [r.company])).rows[0]!.id;
  manager = await r.addUser('manager');
});
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]);
  await r.teardown();
});

describe('primary_bank decides where net pay goes when payroll_net_pay is unset: owner/admin only', () => {
  it('a manager gets a 403 for it, alone or beside another key; the bank role does not move; nothing is audited', async () => {
    expect((await save({ primary_bank: bank1120 }, { primary_bank: bank1110 }, manager)).statusCode).toBe(403);
    expect((await save({ primary_bank: bank1120, sales_discount: 'x' }, { primary_bank: bank1110 }, manager)).statusCode).toBe(403);
    expect(await bankHolder()).toBe('1110');
    expect(await audits()).toHaveLength(0);
  });

  it('a manager may still save the other keys', async () => {
    expect((await save({ sales_discount: 'manager-was-here' }, {}, manager)).statusCode).toBe(200);
  });

  it('an admin moves the bank role, and the move is audited with the user and the old and new id and code', async () => {
    expect((await save({ primary_bank: bank1120 }, { primary_bank: bank1110 }, r.admin)).statusCode).toBe(200);
    expect(await bankHolder()).toBe('1120');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(r.admin);
    expect(rows[0].changes.fields).toEqual([expect.objectContaining({
      field: 'primary_bank', old: `1110 BRK 1110 (${bank1110})`, new: `1120 NPR 1120 (${bank1120})`,
    })]);
  });

  it('an owner may move it back', async () => {
    expect((await save({ primary_bank: bank1110 }, { primary_bank: bank1120 }, r.approver)).statusCode).toBe(200);
    expect(await bankHolder()).toBe('1110');
  });
});
