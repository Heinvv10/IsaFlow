/**
 * The guards around Default Accounts' `payroll_net_pay` (review round 1 of feat/payroll-net-pay-clearing), through the
 * real routes (withAuth, app_user, RLS) on a disposable database:
 *
 * (a) the account rule is an ALLOW-LIST: tax, payables, bank, credit-card, long-term and current-portion accounts, a null
 *     subtype and an account a loan uses are 400 on the save, and blocked (never the bank) when hand-written into the row;
 * (b) only an owner or admin may name the key: a manager gets a 403, the other keys behave as before;
 * (c) every change to the key and to a role in the same save has an audit row (who, old and new id and code);
 * (d) the generic settings PUT refuses `accounting_default_accounts`;
 * (e) a setting row that cannot be read blocks the plan (`invalid_net_pay_setting`) and never 500s;
 * (f) the account merge reads the row in TypeScript: a string-encoded row still names its account, a malformed row neither
 *     500s the merge nor names one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import accountingSettings from '../../pages/api/accounting/accounting-settings';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { mergeAccounts } from '../../src/modules/accounting/services/gl/accountMergeService';
import { findConfigurationReferences } from '@/modules/accounting/services/gl/accountMergeReferences';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let c2170 = '';
let manager = '';

const SETTING = 'accounting_default_accounts';
const writeRow = async (value: string | null) => {
  await r.pool.query(
    `INSERT INTO app_settings (key, value, company_id, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key, company_id) DO UPDATE SET value = $2, updated_at = NOW()`, [SETTING, value, r.company]);
};
const setNetPay = (id: string | null) => writeRow(JSON.stringify({ payroll_net_pay: id }));
const stored = async (): Promise<string | null> => (await r.pool.query(
  `SELECT value::TEXT::JSONB ->> 'payroll_net_pay' AS id FROM app_settings WHERE key = $1 AND company_id = $2`, [SETTING, r.company])).rows[0]?.id ?? null;
const addAccount = async (code: string, type: string, subtype: string | null, over: { parent?: string; level?: number } = {}): Promise<string> =>
  (await r.pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account, parent_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8) RETURNING id`,
    [r.company, code, `NPG ${code}`, type, type === 'liability' ? 'credit' : 'debit', over.level ?? 1, subtype, over.parent ?? null])).rows[0]!.id;
const save = (mappings: Record<string, unknown>, loaded: Record<string, unknown>, user?: string) =>
  r.call(defaultAccounts as Route, 'POST', '/api/accounting/default-accounts', undefined, { body: { mappings, loaded }, user });
const audits = async () => (await r.pool.query(
  `SELECT user_id, action, entity_type, entity_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'default_accounts' ORDER BY created_at, id`,
  [r.company])).rows;
let seq = 0;
const nextCode = (): string => `29${String(++seq).padStart(2, '0')}`;
const discard = async (id: string): Promise<void> => {
  await r.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [id]);
  await r.pool.query('DELETE FROM payroll_run_headers WHERE id = $1 AND company_id = $2', [id, r.company]);
};

beforeAll(async () => {
  r = await rig('net-pay-guards');
  await r.setup();
  await r.employee(20000);
  c2170 = await addAccount('2170', 'liability', 'payroll_liability');
  manager = await r.addUser('manager');
});
afterAll(async () => {
  await r.pool.query('DELETE FROM gl_account_merges WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM loans WHERE company_id = $1', [r.company]);
  for (const t of ['audit_log', 'app_settings']) await r.pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [r.company]);
  await r.teardown();
});

describe('(a) the account rule is an allow-list (ledger review HIGH)', () => {
  const refusedSubtypes: Array<[string, string | null]> = [
    ['tax (the VAT201 reads every tax line as output VAT)', 'tax'], ['accounts_payable (AP control spelling)', 'accounts_payable'],
    ['creditors (AP control spelling)', 'creditors'], ['bank_account', 'bank_account'], ['credit_card', 'credit_card'],
    ['long_term_liability', 'long_term_liability'], ['current_liability (2215 current portion of loans)', 'current_liability'],
    ['no subtype', null], ['other', 'other'],
  ];

  it.each(refusedSubtypes)('the save refuses a liability with %s, and stores nothing', async (_name, subtype) => {
    await setNetPay(c2170);
    const id = await addAccount(nextCode(), 'liability', subtype);
    const res = await save({ payroll_net_pay: id }, { payroll_net_pay: c2170 });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error?.message ?? res.body.message)).toMatch(/payroll_liability/);
    expect(await stored()).toBe(c2170);
  });

  it('refuses 2210 Long-term Loans under the 2200 header, however it is classified', async () => {
    const header = await addAccount('2200', 'liability', 'payroll_liability', { level: 1 });
    const kid = await addAccount('2210', 'liability', 'long_term_liability', { parent: header, level: 2 });
    expect((await save({ payroll_net_pay: kid }, { payroll_net_pay: c2170 })).statusCode).toBe(400);
    expect((await save({ payroll_net_pay: header }, { payroll_net_pay: c2170 })).statusCode).toBe(400);
    expect(await stored()).toBe(c2170);
  });

  it('refuses an account a loan uses (loans.current_portion_account_id) even on the payroll_liability subtype', async () => {
    const loanAccount = await addAccount('2216', 'liability', 'payroll_liability');
    await r.pool.query(
      `INSERT INTO loans (company_id, principal, start_date, term_months, rate_mode, current_portion_account_id)
       VALUES ($1, 100000, '2026-01-01', 12, 'FIXED', $2)`, [r.company, loanAccount]);
    const res = await save({ payroll_net_pay: loanAccount }, { payroll_net_pay: c2170 });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error?.message ?? res.body.message)).toMatch(/loan/);
    expect(await stored()).toBe(c2170);
  });

  it('accepts a payroll_liability account in the plural spelling the vocabulary also knows', async () => {
    const plural = await addAccount('2172', 'liability', 'payroll_liabilities');
    expect((await save({ payroll_net_pay: plural }, { payroll_net_pay: c2170 }, r.admin)).statusCode).toBe(200);
    expect(await stored()).toBe(plural);
    await setNetPay(c2170);
  });

  it.each([['tax', 'tax'], ['no subtype', null], ['long_term_liability', 'long_term_liability']])(
    'hand-written into the row, a liability with %s BLOCKS the plan: nothing is credited, and the bank is not used', async (_n, subtype) => {
      const id = await addAccount(nextCode(), 'liability', subtype);
      const run = await r.calculatedRun(1);
      await setNetPay(id);
      try {
        const p = await r.api.preview(run);
        expect(p.body.data!.blocker).toMatchObject({ code: 'not_payroll_liability_net_pay_account' });
        expect((await r.api.approve(run)).statusCode).toBeGreaterThanOrEqual(400);
        expect((await r.header(run)).journal_entry_id).toBeNull();
      } finally {
        await setNetPay(c2170);
        await discard(run);
      }
    });

  it('hand-written into the row, an account a loan uses blocks the plan as loan_net_pay_account', async () => {
    const run = await r.calculatedRun(1);
    const loanAccount = (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '2216'`, [r.company])).rows[0]!.id;
    await setNetPay(loanAccount);
    try {
      expect((await r.api.preview(run)).body.data!.blocker).toMatchObject({ code: 'loan_net_pay_account' });
    } finally {
      await setNetPay(c2170);
      await discard(run);
    }
  });
});

describe('(b) only an owner or admin may name payroll_net_pay (security L1)', () => {
  it('a manager gets a 403 for the key, alone or beside another key, and nothing is saved or audited', async () => {
    await setNetPay(null);
    const before = (await audits()).length;
    expect((await save({ payroll_net_pay: c2170 }, { payroll_net_pay: '' }, manager)).statusCode).toBe(403);
    expect((await save({ payroll_net_pay: c2170, sales_discount: 'x' }, { payroll_net_pay: '' }, manager)).statusCode).toBe(403);
    expect((await save({ payroll_net_pay: '' }, { payroll_net_pay: '' }, manager)).statusCode).toBe(403);
    expect(await stored()).toBeNull();
    expect((await audits()).length).toBe(before);
  });

  it('a manager may still save the other keys', async () => {
    expect((await save({ sales_discount: 'manager-was-here' }, {}, manager)).statusCode).toBe(200);
    const value = (await r.pool.query(`SELECT value FROM app_settings WHERE key = $1 AND company_id = $2`, [SETTING, r.company])).rows[0]!.value;
    expect(JSON.parse(value).sales_discount).toBe('manager-was-here');
  });

  it('an admin and an owner may name it', async () => {
    expect((await save({ payroll_net_pay: c2170 }, { payroll_net_pay: '' }, r.admin)).statusCode).toBe(200);
    expect(await stored()).toBe(c2170);
    expect((await save({ payroll_net_pay: '' }, { payroll_net_pay: c2170 }, r.approver)).statusCode).toBe(200);
    expect(await stored()).toBeNull();
    await setNetPay(c2170);
  });
});

describe('(c) every change is audited, in the same transaction', () => {
  it('setting, moving and clearing payroll_net_pay each write a row naming the user, and the old and new id and code', async () => {
    await setNetPay(null);
    const other = await addAccount('2173', 'liability', 'payroll_liability');
    const start = (await audits()).length;
    expect((await save({ payroll_net_pay: c2170 }, { payroll_net_pay: '' }, r.admin)).statusCode).toBe(200);
    expect((await save({ payroll_net_pay: other }, { payroll_net_pay: c2170 }, r.approver)).statusCode).toBe(200);
    expect((await save({ payroll_net_pay: '' }, { payroll_net_pay: other }, r.admin)).statusCode).toBe(200);
    const rows = (await audits()).slice(start);
    expect(rows).toHaveLength(3);
    expect(rows.map((a) => a.user_id)).toEqual([r.admin, r.approver, r.admin]);
    expect(rows.every((a) => a.action === 'update' && a.entity_id === r.company)).toBe(true);
    const field = (i: number) => rows[i].changes.fields[0];
    expect(field(0)).toMatchObject({ field: 'payroll_net_pay', old: null, new: `2170 NPG 2170 (${c2170})` });
    expect(field(1)).toMatchObject({ old: `2170 NPG 2170 (${c2170})`, new: `2173 NPG 2173 (${other})` });
    expect(field(2)).toMatchObject({ old: `2173 NPG 2173 (${other})`, new: null });
    await setNetPay(c2170);
  });

  it('a role moved in the same save is in the same row; a refused save writes no row; an unchanged one neither', async () => {
    const creditors = await addAccount('2111', 'liability', 'other');
    const start = (await audits()).length;
    expect((await save({ accounts_payable: creditors, payroll_net_pay: '' }, { accounts_payable: '', payroll_net_pay: c2170 }, r.admin)).statusCode).toBe(200);
    const rows = (await audits()).slice(start);
    expect(rows).toHaveLength(1);
    expect(rows[0].changes.fields.map((f: { field: string }) => f.field).sort()).toEqual(['accounts_payable', 'payroll_net_pay']);
    expect(rows[0].changes.fields.find((f: { field: string }) => f.field === 'accounts_payable')).toMatchObject({ old: null, new: `2111 NPG 2111 (${creditors})` });

    const after = (await audits()).length;
    expect((await save({ payroll_net_pay: crypto.randomUUID() }, { payroll_net_pay: '' }, r.admin)).statusCode).toBe(400);
    expect((await save({ sales_discount: 'x' }, {}, r.admin)).statusCode).toBe(200);
    expect((await audits()).length).toBe(after);
    await setNetPay(c2170);
  });
});

describe('(d) the generic settings PUT refuses the Default Accounts row', () => {
  const put = (body: Record<string, unknown>) => r.call(accountingSettings as Route, 'PUT', '/api/accounting/accounting-settings', undefined, { body });

  it('accounting_default_accounts is a 400 for free text and for a well-formed value, and the row is untouched', async () => {
    await setNetPay(c2170);
    expect((await put({ key: SETTING, value: 'not json' })).statusCode).toBe(400);
    expect((await put({ key: SETTING, value: JSON.stringify({ payroll_net_pay: null }) })).statusCode).toBe(400);
    expect(await stored()).toBe(c2170);
    expect((await put({ key: 'reporting_currency', value: 'ZAR' })).statusCode).toBe(200); // a key the pages write still saves
  });

  it('after the refused PUT, a run still calculates and previews (no 500)', async () => {
    await put({ key: SETTING, value: 'not json' });
    const id = await r.calculatedRun(1);
    const p = await r.api.preview(id);
    expect(p.statusCode).toBe(200);
    expect(p.body.data!.blocker).toBeNull();
    await discard(id);
  });
});

describe('(e) an unreadable setting row blocks the plan and never 500s', () => {
  it.each([['text that is not JSON', 'not json'], ['a JSON list', '["x"]'], ['a numeric net pay', '{"payroll_net_pay": 7}']])(
    '%s: preview, calculate and approve answer with a blocker, not a 500, and nothing falls back to the bank', async (_n, value) => {
      const id = await r.calculatedRun(1);
      await writeRow(value);
      try {
        const p = await r.api.preview(id);
        expect(p.statusCode).toBe(200);
        expect(p.body.data!.blocker).toMatchObject({ code: 'invalid_net_pay_setting' });
        expect(p.body.data!.plan.lines.map((l: { accountCode: string }) => l.accountCode)).not.toContain('1110');
        const calc = await r.api.calculate(id);
        expect(calc.statusCode).not.toBe(500);
        const ap = await r.api.approve(id);
        expect(ap.statusCode).toBeGreaterThanOrEqual(400);
        expect(ap.statusCode).toBeLessThan(500);
        expect((await r.header(id)).journal_entry_id).toBeNull();
      } finally {
        await setNetPay(c2170);
        await discard(id);
      }
    });

  it('a row written twice (JSON text of a JSON string) is read through: it posts to 2170', async () => {
    await writeRow(JSON.stringify(JSON.stringify({ payroll_net_pay: c2170 })));
    const id = await r.calculatedRun(1);
    try {
      const p = await r.api.preview(id);
      expect(p.body.data!.blocker).toBeNull();
      expect(p.body.data!.plan.lines.map((l: { accountCode: string }) => l.accountCode)).toContain('2170');
    } finally {
      await setNetPay(c2170);
      await discard(id);
    }
  });
});

describe('(f) the account merge reads the row in TypeScript', () => {
  const merge = async (source: string, target: string) => {
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ client, userId: r.admin, companyId: r.company, claims: {} } as unknown as Parameters<typeof als.run>[0],
        () => mergeAccounts(r.company, source, target, r.admin));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  };

  it.each([
    ['an object', (id: string) => JSON.stringify({ payroll_net_pay: id })],
    ['JSON text of a JSON string', (id: string) => JSON.stringify(JSON.stringify({ payroll_net_pay: id }))],
    ['an upper-case id (the plan resolves ids as UUIDs, which ignore case)', (id: string) => JSON.stringify({ payroll_net_pay: id.toUpperCase() })],
  ])('names the account when the row is %s', async (_n, encode) => {
    await writeRow(encode(c2170));
    expect(await findConfigurationReferences(r.company, c2170)).toEqual([
      { table: 'app_settings', column: 'accounting_default_accounts.payroll_net_pay', rows: 1 },
    ]);
  });

  it('a string-encoded row stops a real merge of the named account (it used to read as nothing and orphan the setting)', async () => {
    const source = await addAccount('2180', 'liability', 'payroll_liability');
    const target = await addAccount('2181', 'liability', 'payroll_liability');
    await writeRow(JSON.stringify(JSON.stringify({ payroll_net_pay: source })));
    await expect(merge(source, target)).rejects.toMatchObject({ code: 'source_referenced_by_configuration' });
  });

  it('a malformed row neither throws nor names an account: the merge goes ahead', async () => {
    const source = await addAccount('2182', 'liability', 'payroll_liability');
    const target = await addAccount('2183', 'liability', 'payroll_liability');
    await writeRow('not json');
    await expect(findConfigurationReferences(r.company, source)).resolves.toEqual([]);
    await expect(merge(source, target)).resolves.toBeDefined();
    await setNetPay(c2170);
  });

});
