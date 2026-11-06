/**
 * Default Accounts' `payroll_net_pay` through the real route (validation, stale page 409, clearing) and the account
 * merge's view of the setting. Split from payroll-net-pay-clearing.int.test.ts (file size); same rig. Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { findConfigurationReferences } from '@/modules/accounting/services/gl/accountMergeReferences';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let c2170 = '';
let c2171 = '';

const SETTING = 'accounting_default_accounts';
const setNetPay = async (id: string | null) => {
  await r.pool.query(
    `INSERT INTO app_settings (key, value, company_id, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key, company_id) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [SETTING, JSON.stringify({ payroll_net_pay: id }), r.company]);
};
const stored = async (): Promise<string | null> => (await r.pool.query(
  `SELECT value::TEXT::JSONB ->> 'payroll_net_pay' AS id FROM app_settings WHERE key = $1 AND company_id = $2`, [SETTING, r.company])).rows[0]?.id ?? null;
const flag = async (code: string, patch: { active?: boolean }) => {
  await r.pool.query('UPDATE gl_accounts SET is_active = $3 WHERE company_id = $1 AND account_code = $2', [r.company, code, patch.active]);
  clearSystemAccountCache(r.company);
};
const addAccount = async (code: string, type: string, subtype: string | null, over: { parent?: string; level?: number } = {}): Promise<string> =>
  (await r.pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account, parent_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8) RETURNING id`,
    [r.company, code, `NPC ${code}`, type, type === 'liability' ? 'credit' : 'debit', over.level ?? 1, subtype, over.parent ?? null])).rows[0]!.id;
const discard = async (id: string): Promise<void> => {
  await r.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [id]);
  await r.pool.query('DELETE FROM payroll_run_headers WHERE id = $1 AND company_id = $2', [id, r.company]);
};
const save = (mappings: Record<string, unknown>, loaded: Record<string, unknown>) =>
  r.call(defaultAccounts as Route, 'POST', '/api/accounting/default-accounts', undefined, { body: { mappings, loaded } });

beforeAll(async () => {
  r = await rig('net-pay-save');
  await r.setup(); // 1110 holds the bank role
  await r.employee(20000);
  c2170 = await addAccount('2170', 'liability', 'payroll_liability');
  c2171 = await addAccount('2171', 'liability', 'payroll_liability');
});
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM app_settings WHERE company_id = $1', [r.company]);
  await r.teardown();
});

describe('(e) Default Accounts: PUT-style save of payroll_net_pay', () => {
  const idOf = async (code: string) => (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = $2`, [r.company, code])).rows[0]!.id as string;

  it('accepts 2170, shows it on GET, and a stale page is a 409', async () => {
    await setNetPay(null);
    const ok = await save({ payroll_net_pay: c2170 }, { payroll_net_pay: '' });
    expect(ok.statusCode).toBe(200);
    expect(await stored()).toBe(c2170);
    const got = await r.call(defaultAccounts as Route, 'GET', '/api/accounting/default-accounts', undefined);
    expect(got.body.data!.mappings.payroll_net_pay).toBe(c2170);

    const stale = await save({ payroll_net_pay: c2171 }, { payroll_net_pay: '' }); // the page loaded before 2170 was set
    expect(stale.statusCode).toBe(409);
    expect(await stored()).toBe(c2170);
  });

  it('refuses 2140, an asset, an unknown id, a header and an inactive account with a 400, and stores nothing', async () => {
    const header = await addAccount('2200', 'liability', null, { level: 1 });
    await addAccount('2210', 'liability', null, { parent: header, level: 2 });
    const off = await addAccount('2299', 'liability', 'payroll_liability');
    await flag('2299', { active: false });
    const tries = [await idOf('2140'), await idOf('1110'), crypto.randomUUID(), header, off];
    for (const bad of tries) {
      const res = await save({ payroll_net_pay: bad }, { payroll_net_pay: c2170 });
      expect(res.statusCode, `id ${bad}`).toBe(400);
      expect(await stored()).toBe(c2170);
    }
  });

  it('refuses one account named for two roles', async () => {
    const res = await save({ payroll_net_pay: c2171, accounts_payable: c2171 }, { payroll_net_pay: c2170, accounts_payable: '' });
    expect(res.statusCode).toBe(400);
    expect(await stored()).toBe(c2170);
  });

  it('clearing it (empty) returns net pay to the bank, and a stale clear is a 409', async () => {
    const stale = await save({ payroll_net_pay: '' }, { payroll_net_pay: '' });
    expect(stale.statusCode).toBe(409);
    const ok = await save({ payroll_net_pay: '' }, { payroll_net_pay: c2170 });
    expect(ok.statusCode).toBe(200);
    expect(await stored()).toBeNull();
    const id = await r.calculatedRun(10);
    const plan = await r.api.preview(id);
    expect(plan.body.data!.plan.lines.map((l: { accountCode: string }) => l.accountCode)).toContain('1110');
    await discard(id);
    await setNetPay(c2170);
  });

  it('a save that does not name it leaves it alone', async () => {
    const ok = await save({ sales_discount: '' }, {});
    expect(ok.statusCode).toBe(200);
    expect(await stored()).toBe(c2170);
  });
});

describe('(g) the account merge sees the setting', () => {
  it('2170 is named by configuration while it is set; another account is not; cleared, it is free', async () => {
    await setNetPay(c2170);
    expect(await findConfigurationReferences(r.company, c2170)).toEqual([
      { table: 'app_settings', column: 'accounting_default_accounts.payroll_net_pay', rows: 1 },
    ]);
    expect(await findConfigurationReferences(r.company, c2171)).toEqual([]);
    await setNetPay(null);
    expect(await findConfigurationReferences(r.company, c2170)).toEqual([]);
  });
});
