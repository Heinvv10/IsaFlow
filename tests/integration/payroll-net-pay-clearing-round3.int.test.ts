/**
 * Review round 3 of feat/payroll-net-pay-clearing; disposable DB only, real routes and the MCP registry.
 *
 * With payroll_net_pay unset, payroll credits net pay to the bank-role holder, so whoever gives an EMPTY bank role a holder
 * decides where net pay goes. A manager reached that through the MCP update_gl_account tool (reactivating a deactivated
 * system bank account). Now: refused for a non-owner/admin, and every path that fills an empty bank role writes the audit
 * row Default Accounts writes (key primary_bank, old = none): the MCP tool, the chart-of-accounts routes, bank-accounts,
 * and the coa-seed template seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import accountDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import coaSeed from '../../pages/api/accounting/coa-seed';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let manager = '';
let stub = '';

const holders = async (): Promise<string[]> => (await r.pool.query(
  `SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'bank' AND is_system_account AND is_active`, [r.company])).rows.map((x) => x.account_code);
const audits = async () => (await r.pool.query(
  `SELECT user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'default_accounts' ORDER BY created_at, id`, [r.company])).rows;
/** The bank role empty again: every system bank row deactivated (the legacy shape Brightsphere had). */
const emptyTheRole = async () => { await r.pool.query(`UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_subtype = 'bank'`, [r.company]); clearSystemAccountCache(r.company); };
const idOf = async (code: string) => (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = $2`, [r.company, code])).rows[0]!.id as string;

async function tool(name: string, args: Record<string, unknown>, user: string, role: string) {
  const ctx = { userId: user, companyId: r.company, scopes: ['write:accounts', 'read:accounting'], tokenJti: null, oauthAppId: null, companyRole: role };
  const res = await withAlsTransaction({ userId: user, companyId: r.company },
    () => mcpRegistry.call(name, { idempotency_key: `r3-${crypto.randomUUID()}`, ...args }, ctx as never)) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
}
const fieldOf = async (user: string) => {
  const rows = (await audits()).filter((a) => a.user_id === user);
  return rows[rows.length - 1]?.changes.fields[0];
};

beforeAll(async () => {
  r = await rig('net-pay-round3');
  await r.setup(); // 1110 holds the bank role
  stub = (await r.pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account, is_active)
     VALUES ($1, '1199', 'Manager pick', 'asset', 'debit', 1, 'bank', true, false) RETURNING id`, [r.company])).rows[0]!.id;
  await emptyTheRole();
  manager = await r.addUser('manager');
});
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM mcp_idempotency WHERE company_id = $1', [r.company]).catch(() => undefined);
  await r.teardown();
});

describe('a manager cannot fill the empty bank role (MCP update_gl_account)', () => {
  it('control: Default Accounts refuses the manager naming primary_bank', async () => {
    const x = await r.call(defaultAccounts as Route, 'POST', '/api/accounting/default-accounts', undefined, {
      user: manager, body: { mappings: { primary_bank: stub }, loaded: { primary_bank: '' } } });
    expect(x.statusCode).toBe(403);
  });

  it('reactivating a deactivated system bank account is refused for the manager: the role stays empty, nothing audited', async () => {
    expect(await holders()).toEqual([]);
    const x = await tool('update_gl_account', { account_id: stub, is_active: true }, manager, 'manager');
    expect(x.isError).toBe(true);
    expect(x.text).toMatch(/owner or admin/);
    clearSystemAccountCache(r.company);
    expect(await holders()).toEqual([]);
    expect(await audits()).toHaveLength(0);
  });

  it('a manager may still reactivate an ordinary account (the gate is the bank role only)', async () => {
    const plain = (await r.pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_active)
       VALUES ($1, '1500', 'Plain', 'asset', 'debit', 1, 'other', false) RETURNING id`, [r.company])).rows[0]!.id;
    const x = await tool('update_gl_account', { account_id: plain, is_active: true }, manager, 'manager');
    expect(x.isError).toBe(false);
    expect(await audits()).toHaveLength(0);
  });
});

describe('every path that fills the empty bank role audits it (user, old = none, new id and code)', () => {
  it('MCP update_gl_account by an owner', async () => {
    const x = await tool('update_gl_account', { account_id: stub, is_active: true }, r.approver, 'owner');
    expect(x.isError).toBe(false);
    clearSystemAccountCache(r.company);
    expect(await holders()).toEqual(['1199']);
    expect(await fieldOf(r.approver)).toMatchObject({ field: 'primary_bank', old: null, new: `1199 Manager pick (${stub})` });
  });

  it('a reactivation that leaves a holder in place (a move, not a fill) writes nothing extra', async () => {
    const before = (await audits()).length;
    expect((await tool('update_gl_account', { account_id: stub, account_name: 'Renamed' }, r.approver, 'owner')).isError).toBe(false);
    expect((await audits()).length).toBe(before);
  });

  it('chart-of-accounts-detail PUT by an admin', async () => {
    await emptyTheRole();
    const res = await r.call(accountDetail as Route, 'PUT', '/api/accounting/chart-of-accounts-detail', stub, { user: r.admin, body: { id: stub, isActive: true } });
    expect(res.statusCode).toBe(200);
    expect(await fieldOf(r.admin)).toMatchObject({ field: 'primary_bank', old: null, new: `1199 Renamed (${stub})` });
  });

  it('bank-accounts PUT by an admin', async () => {
    await emptyTheRole();
    const before = (await audits()).length;
    const res = await r.call(bankAccounts as Route, 'PUT', '/api/accounting/bank-accounts', undefined, { user: r.admin, body: { id: stub, isActive: true } });
    expect(res.statusCode).toBe(200);
    const rows = await audits();
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1].changes.fields[0]).toMatchObject({ field: 'primary_bank', old: null, new: `1199 Renamed (${stub})` });
  });

  it('coa-seed by an admin, when the template creates the bank holder', async () => {
    await r.pool.query(`UPDATE gl_accounts SET is_system_account = false WHERE id = $1`, [stub]);
    await r.pool.query(`DELETE FROM gl_accounts WHERE company_id = $1 AND account_code = '1110'`, [r.company]);
    clearSystemAccountCache(r.company);
    expect(await holders()).toEqual([]);
    const before = (await audits()).length;
    const res = await r.call(coaSeed as Route, 'POST', '/api/accounting/coa-seed', undefined, { user: r.admin, body: { template: 'isaflow_standard' } });
    expect(res.statusCode).toBe(200);
    const seeded = await idOf('1110');
    expect(await holders()).toEqual(['1110']);
    const rows = await audits();
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1].user_id).toBe(r.admin);
    expect(rows[rows.length - 1].changes.fields[0]).toMatchObject({ field: 'primary_bank', old: null, new: expect.stringContaining(`(${seeded})`) });
  });

  it('coa-seed over a chart that already has a bank holder writes no audit row', async () => {
    const before = (await audits()).length;
    expect((await r.call(coaSeed as Route, 'POST', '/api/accounting/coa-seed', undefined, { user: r.admin, body: { template: 'isaflow_standard' } })).statusCode).toBe(200);
    expect((await audits()).length).toBe(before);
  });
});
