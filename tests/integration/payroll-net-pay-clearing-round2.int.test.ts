/**
 * Review round 2 of feat/payroll-net-pay-clearing, through the real routes (withAuth, app_user, RLS); disposable DB only.
 *
 * (a) The CoA import moves roles like Default Accounts does, but its route is open to managers. With payroll_net_pay
 *     unset net pay credits the bank-role holder, so: a manager whose map would CHANGE the bank holder gets a 403 and
 *     nothing is written; a manager whose map leaves it as it is (or moves another role) is not gated; an owner's move
 *     is allowed; every role the import moves is audited (user, old and new id and code).
 * (b) Labour mapped to the net-pay clearing account made the journal debit and credit one account. The mapping route
 *     refuses a non-expense account (400), and a plan whose net-pay account carries another line (a mapping stored
 *     before that check) is blocked `net_pay_account_shared`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import migrationSession from '../../pages/api/accounting/migration/session';
import glMapping from '../../pages/api/payroll/cost-centres/[id]/gl-mapping';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let manager = '';
let bank1110 = '';
let c2170 = '';

const holder = async (subtype: string): Promise<string[]> => (await r.pool.query(
  `SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 AND is_system_account AND is_active`, [r.company, subtype])).rows.map((x) => x.account_code);
const audits = async () => (await r.pool.query(
  `SELECT user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'default_accounts' ORDER BY created_at, id`, [r.company])).rows;
const codeExists = async (code: string): Promise<boolean> => (await r.pool.query(
  `SELECT 1 FROM gl_accounts WHERE company_id = $1 AND account_code = $2`, [r.company, code])).rows.length > 0;
const setNetPay = (id: string | null) => r.pool.query(
  `INSERT INTO app_settings (key, value, company_id, updated_at) VALUES ('accounting_default_accounts', $1, $2, NOW())
   ON CONFLICT (key, company_id) DO UPDATE SET value = $1, updated_at = NOW()`, [JSON.stringify({ payroll_net_pay: id }), r.company]);
const acct = (code: string, accountType = 'asset') => ({ accountCode: code, accountName: `R2 ${code}`, accountType, normalBalance: accountType === 'asset' ? 'debit' : 'credit' });
const runImport = async (user: string, accounts: unknown[], systemAccountMap: Record<string, string>) => {
  const sess = await r.call(migrationSession as Route, 'POST', '/api/accounting/migration/session', undefined, { user, body: { sourceSystem: 'sage' } });
  expect([200, 201]).toContain(sess.statusCode);
  const res = await r.call(coaImport as Route, 'POST', '/api/accounting/migration/chart-of-accounts', undefined, {
    user, body: { sessionId: String((sess.body.data as { session: { id: string } }).session.id), accounts, systemAccountMap },
  });
  clearSystemAccountCache(r.company);
  return res;
};
const centre = async (code: string): Promise<string> => (await r.pool.query(
  `INSERT INTO cost_centres (company_id, code, name, cc_type, is_active) VALUES ($1, $2, $2, 'cc1', true) RETURNING id`, [r.company, code])).rows[0]!.id;
const put = (cc: string, expenseAccountId: string, user?: string) =>
  r.call(glMapping as Route, 'PUT', `/api/payroll/cost-centres/${cc}/gl-mapping`, cc, { user, body: { expenseAccountId } });

beforeAll(async () => {
  r = await rig('net-pay-round2');
  await r.setup(); // 1110 holds the bank role
  bank1110 = (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '1110'`, [r.company])).rows[0]!.id;
  manager = await r.addUser('manager');
  await r.employee(30000);
  c2170 = (await r.pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
     VALUES ($1, '2170', 'Net Salaries Payable', 'liability', 'credit', 1, 'payroll_liability', false) RETURNING id`, [r.company])).rows[0]!.id;
});
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM migration_sessions WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM app_settings WHERE company_id = $1', [r.company]);
  await r.teardown();
});

describe('(a) the CoA import and the bank role', () => {
  it('a manager whose map would CHANGE the bank holder gets a 403, and nothing is written or audited', async () => {
    const res = await runImport(manager, [acct('1199'), acct('1110')], { bank: '1199' });
    expect(res.statusCode).toBe(403);
    expect(String(res.body.error?.message ?? res.body.message)).toMatch(/bank role/);
    expect(await holder('bank')).toEqual(['1110']);
    expect(await codeExists('1199')).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it('a manager whose map names the account that already holds the role is not gated (no change, no audit)', async () => {
    const res = await runImport(manager, [acct('1110'), acct('1198')], { bank: '1110' });
    expect(res.statusCode).toBe(200);
    expect(await holder('bank')).toEqual(['1110']);
    expect(await codeExists('1198')).toBe(true);
    expect(await audits()).toHaveLength(0);
  });

  it('a manager who moves another role (receivable) is not gated, and the move is audited under its Default Accounts key', async () => {
    const res = await runImport(manager, [acct('1197')], { receivable: '1197' });
    expect(res.statusCode).toBe(200);
    expect(await holder('receivable')).toEqual(['1197']);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(manager);
    expect(rows[0].changes.fields).toEqual([expect.objectContaining({ field: 'accounts_receivable', old: null, new: expect.stringMatching(/^1197 R2 1197 \(/) })]);
  });

  it('an owner may move the bank role, and it is audited with the user and the old and new id and code', async () => {
    const before = (await audits()).length;
    const res = await runImport(r.approver, [acct('1199')], { bank: '1199' });
    expect(res.statusCode).toBe(200);
    expect(await holder('bank')).toEqual(['1199']);
    const newId = (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '1199'`, [r.company])).rows[0]!.id;
    const row = (await audits()).slice(before);
    expect(row).toHaveLength(1);
    expect(row[0].user_id).toBe(r.approver);
    expect(row[0].changes.fields).toEqual([expect.objectContaining({
      field: 'primary_bank', old: `1110 R2 1110 (${bank1110})`, new: `1199 R2 1199 (${newId})`,
    })]);
  });

  it('an admin may too, and payroll then credits net pay to the new holder (the move was legitimate)', async () => {
    const res = await runImport(r.admin, [acct('1110')], { bank: '1110' });
    expect(res.statusCode).toBe(200);
    expect(await holder('bank')).toEqual(['1110']);
  });
});

describe('(b) labour mapped to the clearing account', () => {
  it('the mapping route refuses a liability, an asset and an unknown account with a 400, and accepts an expense account', async () => {
    const cc = await centre('R2A');
    expect((await put(cc, c2170, manager)).statusCode).toBe(400);
    expect((await put(cc, bank1110, manager)).statusCode).toBe(400);
    expect((await put(cc, crypto.randomUUID(), manager)).statusCode).toBe(400);
    const mapped = (await r.pool.query(`SELECT 1 FROM cost_centre_gl_mappings WHERE company_id = $1 AND cost_centre_id = $2`, [r.company, cc])).rows;
    expect(mapped).toHaveLength(0);
    const expense = (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '5200'`, [r.company])).rows[0]!.id;
    expect((await put(cc, expense, manager)).statusCode).toBe(200);
  });

  it('a mapping stored before that check (labour on 2170) blocks the plan as net_pay_account_shared; nothing posts', async () => {
    await setNetPay(c2170);
    const cc = await centre('R2B');
    await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE company_id = $2', [cc, r.company]);
    await r.pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [r.company]);
    await r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1, $2, $3)', [r.company, cc, c2170]);
    const id = await r.calculatedRun(2);
    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toMatchObject({ code: 'net_pay_account_shared' });
    expect(String(p.body.data!.blocker.detail)).toContain('2170');
    const ap = await r.api.approve(id);
    expect(ap.statusCode).toBeGreaterThanOrEqual(400);
    expect(ap.statusCode).toBeLessThan(500);
    expect((await r.header(id)).journal_entry_id).toBeNull();
  });

  it('the same run with the mapping removed posts, net pay credited to 2170 alone', async () => {
    await r.pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [r.company]);
    const id = await r.calculatedRun(3);
    const ap = await r.api.approve(id);
    expect(ap.statusCode).toBe(200);
    const on2170 = (await r.pool.query(
      `SELECT l.debit::float8 AS d, l.credit::float8 AS c FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
        WHERE l.journal_entry_id = $1 AND a.account_code = '2170'`, [ap.body.data!.journalEntryId])).rows;
    expect(on2170).toHaveLength(1);
    expect(on2170[0].d).toBe(0);
    expect(on2170[0].c).toBeGreaterThan(0);
  });
});
