/**
 * Payroll net pay credited to a clearing liability (2170 Net Salaries Payable)
 * instead of the bank, when Default Accounts' `payroll_net_pay` names it.
 *
 * Velocity Fibre pays salaries by bank lines allocated DR 2170 / CR bank (47 in
 * October, R803,850). A pay run that also credits the bank counts net pay twice.
 * Through the real routes (withAuth, app_user, RLS) and the real GL poster; the
 * posted journal_lines are what is asserted, not the preview. Disposable DB only.
 *
 * (a) the setting set by a direct app_settings write -> posts to 2170, no bank line
 * (b) no usable bank holder -> still posts
 * (c) Velocity shape: the salary bank allocation leaves 2170 at nil and the bank credited once
 * (d) re-approval in both directions is refused (net_pay_target_changed); unchanged re-locks
 * (e) the Default Accounts route: validation, stale page, clearing
 * (f) a deactivated or dangling account blocks; nothing falls back to the bank
 * (g) the account merge sees the setting
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
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

/** The posted journal's lines by account code: net debit - credit, in cents. */
const lines = async (journalId: string): Promise<Record<string, number>> => Object.fromEntries((await r.pool.query(
  `SELECT a.account_code, round(sum(l.debit - l.credit) * 100)::int AS c FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 GROUP BY a.account_code`, [journalId])).rows.map((x) => [x.account_code, x.c]));
/** Every posted line of the company on an account: [debit, credit] in cents. */
const ledgerOf = async (code: string): Promise<{ debit: number; credit: number }> => {
  const row = (await r.pool.query(
    `SELECT COALESCE(round(sum(l.debit) * 100), 0)::int AS d, COALESCE(round(sum(l.credit) * 100), 0)::int AS c
       FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE e.company_id = $1 AND e.status = 'posted' AND a.account_code = $2`, [r.company, code])).rows[0]!;
  return { debit: row.d, credit: row.c };
};
const liveJournals = async (): Promise<number> => Number((await r.pool.query(
  `SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted' AND reversed_at IS NULL AND reversal_of_id IS NULL
      AND description LIKE 'Payroll run %'`, [r.company])).rows[0]!.n);
const netCents = async (id: string): Promise<number> => Math.round((await r.header(id)).net * 100);
const approve = async (month: number) => {
  const id = await r.calculatedRun(month);
  const ap = await r.api.approve(id);
  expect(ap.statusCode).toBe(200);
  return { id, journal: String(ap.body.data!.journalEntryId), net: await netCents(id) };
};
/** A calculated run that was only previewed or refused: dropped so its month can be used again. */
const discard = async (id: string): Promise<void> => {
  await r.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [id]);
  await r.pool.query('DELETE FROM payroll_run_headers WHERE id = $1 AND company_id = $2', [id, r.company]);
};
const balance = async (code: string): Promise<number> => { const l = await ledgerOf(code); return l.credit - l.debit; };
/** The salary bank allocation Velocity books for a payroll month: DR 2170 / CR the bank, for net pay. */
async function allocateSalaries(cents: number, tag: string): Promise<void> {
  const [clearing, bank] = [c2170, (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '1110'`, [r.company])).rows[0]!.id];
  const entry = await createJournalEntry(r.company, {
    entryDate: '2026-12-15', description: `Salary payments ${tag}`, source: 'manual',
    lines: [{ glAccountId: clearing, debit: cents / 100, credit: 0 }, { glAccountId: bank, debit: 0, credit: cents / 100 }],
  }, r.admin);
  await postJournalEntry(r.company, entry.id, r.admin);
}
const save = (mappings: Record<string, unknown>, loaded: Record<string, unknown>) =>
  r.call(defaultAccounts as Route, 'POST', '/api/accounting/default-accounts', undefined, { body: { mappings, loaded } });

beforeAll(async () => {
  r = await rig('net-pay-clearing');
  await r.setup(); // 1110 holds the bank role
  await r.employee(20000);
  c2170 = await addAccount('2170', 'liability', 'payroll_liability');
  c2171 = await addAccount('2171', 'liability', 'payroll_liability');
});
afterAll(async () => {
  await r.pool.query('DELETE FROM app_settings WHERE company_id = $1', [r.company]);
  await r.teardown();
});

describe('(a) the setting on: net pay is credited to 2170', () => {
  it('posts DR labour / CR 2140, 2150, 2170 = net, no line on any bank account, and balances', async () => {
    await setNetPay(c2170);
    const id = await r.calculatedRun(1);
    const net = await netCents(id);
    const preview = await r.api.preview(id);
    expect(preview.body.data!.blocker).toBeNull();
    const ap = await r.api.approveWith(id, preview.body.data!.planHash);
    expect(ap.statusCode).toBe(200);
    const j = await lines(String(ap.body.data!.journalEntryId));
    expect(j['2170']).toBe(-net);
    expect(j['2140']).toBeLessThan(0);
    expect(j['2150']).toBeLessThan(0);
    expect(j['2160']).toBeUndefined(); // R20,000 a month is under the SDL threshold: the nil line is dropped
    expect(j['5200']).toBeGreaterThan(0);
    expect(j['1110']).toBeUndefined();
    const bankLines = Number((await r.pool.query(
      `SELECT count(*) AS n FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
        WHERE l.journal_entry_id = $1 AND a.account_subtype = 'bank'`, [ap.body.data!.journalEntryId])).rows[0]!.n);
    expect(bankLines).toBe(0);
    expect(Object.values(j).reduce((s, v) => s + v, 0)).toBe(0); // balances
    const description = (await r.pool.query(
      `SELECT l.description FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id WHERE l.journal_entry_id = $1 AND a.account_code = '2170'`,
      [ap.body.data!.journalEntryId])).rows[0]!.description;
    expect(description).toBe('Net pay — net salaries payable');
  });
});

describe('(c) Velocity shape: the salary bank allocation clears 2170 and the bank is credited once', () => {
  it('with the setting on, the run plus its allocation leave 2170 unchanged and the bank credited exactly net', async () => {
    const [clearing0, bank0] = [await balance('2170'), await ledgerOf('1110')];
    const run = await approve(2);
    expect(await balance('2170') - clearing0).toBe(run.net); // owed to employees until the bank pays them
    await allocateSalaries(run.net, 'm2');
    expect(await balance('2170') - clearing0).toBe(0);
    const bank = await ledgerOf('1110');
    expect(bank.credit - bank0.credit).toBe(run.net);
    expect(bank.debit - bank0.debit).toBe(0);
  });

  it('control: with the bank credited by the run as well, the same allocation counts net pay twice', async () => {
    await setNetPay(null);
    const [clearing0, bank0] = [await balance('2170'), await ledgerOf('1110')];
    const run = await approve(3);
    await allocateSalaries(run.net, 'm3');
    expect(await balance('2170') - clearing0).toBe(-run.net); // 2170 left in debit: net pay paid out twice
    expect((await ledgerOf('1110')).credit - bank0.credit).toBe(2 * run.net);
    await setNetPay(c2170);
  });
});

describe('(b) no usable bank holder', () => {
  it('still posts to 2170: the bank role is not consulted', async () => {
    await flag('1110', { active: false });
    try {
      const run = await approve(4);
      const j = await lines(run.journal);
      expect(j['2170']).toBe(-run.net);
      expect(j['1110']).toBeUndefined();
    } finally {
      await flag('1110', { active: true });
    }
  });

  it('and the same company in bank mode is refused with missing_bank_account', async () => {
    await setNetPay(null);
    await flag('1110', { active: false });
    try {
      const id = await r.calculatedRun(10);
      expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'missing_bank_account' });
      await discard(id);
    } finally {
      await flag('1110', { active: true });
      await setNetPay(c2170);
    }
  });
});

describe('(d) re-approving onto an in-force journal after the target changed', () => {
  const refused = async (id: string) => {
    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toMatchObject({ code: 'net_pay_target_changed' });
    expect(String(p.body.data!.blocker.detail)).toMatch(/reverse journal/);
    const again = await r.api.approveWith(id, p.body.data!.planHash);
    expect(again.statusCode).toBe(400);
    return p;
  };

  it('bank journal, setting now 2170: refused (not a silent re-lock); reverse then approve credits 2170', async () => {
    await setNetPay(null);
    const run = await approve(6);
    expect((await lines(run.journal))['1110']).toBe(-run.net);
    expect((await r.api.reopen(run.id)).statusCode).toBe(200);
    await setNetPay(c2170);

    const live = await liveJournals();
    await refused(run.id);
    expect(await liveJournals()).toBe(live);

    expect((await r.api.reverse(run.journal)).statusCode).toBe(200);
    const fresh = await r.api.approve(run.id);
    expect(fresh.statusCode).toBe(200);
    const j = await lines(String(fresh.body.data!.journalEntryId));
    expect(j['2170']).toBe(-run.net);
    expect(j['1110']).toBeUndefined();

    // ... and back: a 2170 journal, setting now the bank.
    expect((await r.api.reopen(run.id)).statusCode).toBe(200);
    await setNetPay(null);
    await refused(run.id);
    expect((await r.api.reverse(String(fresh.body.data!.journalEntryId))).statusCode).toBe(200);
    const back = await r.api.approve(run.id);
    expect(back.statusCode).toBe(200);
    expect((await lines(String(back.body.data!.journalEntryId)))['1110']).toBe(-run.net);
    await setNetPay(c2170);
  });

  it('2170 journal, setting moved to another clearing account: refused as a target change', async () => {
    const run = await approve(7);
    expect((await r.api.reopen(run.id)).statusCode).toBe(200);
    await setNetPay(c2171);
    await refused(run.id);
    await setNetPay(c2170);
  });

  it('unchanged clearing run re-locks onto its journal and posts nothing', async () => {
    const run = await approve(8);
    expect((await r.api.reopen(run.id)).statusCode).toBe(200);
    const live = await liveJournals();
    const p = await r.api.preview(run.id);
    expect(p.body.data!.blocker).toBeNull();
    const again = await r.api.approveWith(run.id, p.body.data!.planHash);
    expect(again.statusCode).toBe(200);
    expect(String(again.body.data!.journalEntryId)).toBe(run.journal);
    expect(await liveJournals()).toBe(live);
    expect((await r.header(run.id)).status).toBe('approved');
  });

  it('unchanged bank run still re-locks, even after the setting was switched on and off again', async () => {
    await setNetPay(null);
    const run = await approve(9);
    expect((await r.api.reopen(run.id)).statusCode).toBe(200);
    const p = await r.api.preview(run.id);
    expect(p.body.data!.blocker).toBeNull();
    expect((await r.api.approveWith(run.id, p.body.data!.planHash)).statusCode).toBe(200);
    await setNetPay(c2170);
  });
});

describe('(f) an unusable clearing account blocks; nothing falls back to the bank', () => {
  const noJournal = async (id: string) => {
    const h = await r.header(id);
    expect([h.status, h.journal_entry_id]).toEqual(['calculated', null]);
    await discard(id);
  };

  it('a deactivated 2170 is inactive_target_account', async () => {
    const id = await r.calculatedRun(10);
    await flag('2170', { active: false });
    try {
      const p = await r.api.preview(id);
      expect(p.body.data!.blocker).toMatchObject({ code: 'inactive_target_account' });
      expect(JSON.stringify(p.body.data!.blocker)).toContain('2170');
      expect((await r.api.approve(id)).statusCode).toBeGreaterThanOrEqual(400);
      await noJournal(id);
    } finally {
      await flag('2170', { active: true });
    }
  });

  it('an id that no longer exists is missing_net_pay_account, not the bank', async () => {
    const id = await r.calculatedRun(10);
    await setNetPay(crypto.randomUUID());
    try {
      const p = await r.api.preview(id);
      expect(p.body.data!.blocker).toMatchObject({ code: 'missing_net_pay_account' });
      expect((await r.api.approve(id)).statusCode).toBeGreaterThanOrEqual(400);
      await noJournal(id);
    } finally {
      await setNetPay(c2170);
    }
  });

  it.each([
    ['an asset', async () => (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '1110'`, [r.company])).rows[0]!.id, 'not_liability_net_pay_account'],
    ['2140', async () => (await r.pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '2140'`, [r.company])).rows[0]!.id, 'net_pay_account_conflict'],
  ])('%s hand-written into the setting', async (_name, pick, code) => {
    const id = await r.calculatedRun(10);
    await setNetPay(await pick());
    try {
      expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code });
      expect((await r.api.approve(id)).statusCode).toBeGreaterThanOrEqual(400);
      await noJournal(id);
    } finally {
      await setNetPay(c2170);
    }
  });
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
