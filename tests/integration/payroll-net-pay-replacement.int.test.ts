/**
 * A pay run whose journal was REVERSED after the Payroll net pay setting moved is replaced by a journal that credits
 * TODAY's setting, while the salary cash was booked against the old journal's account and stays there (ledger review
 * round 1, MEDIUM). The gate cannot tell which case the person is in, so the preview AND the approval answer carry the
 * advisory `net_pay_target_replaced`, naming both accounts; it never blocks, and an unchanged target has none.
 *
 * Through the real routes (withAuth, app_user, RLS) and the real GL poster; disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let c2170 = '';

const SETTING = 'accounting_default_accounts';
const setNetPay = async (id: string | null) => {
  await r.pool.query(
    `INSERT INTO app_settings (key, value, company_id, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key, company_id) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [SETTING, JSON.stringify({ payroll_net_pay: id }), r.company]);
};
const creditedCodes = async (journalId: string): Promise<string[]> => (await r.pool.query(
  `SELECT a.account_code FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 AND l.credit > 0 ORDER BY a.account_code`, [journalId])).rows.map((x) => x.account_code);
type Note = { code: string; detail: string };
const replacedNote = (notes: Note[] | undefined): Note | undefined => notes?.find((n) => n.code === 'net_pay_target_replaced');

/** A run approved under `before`, reopened, its journal reversed, and the setting moved to `after`. */
async function reversedRun(month: number, before: string | null, after: string | null): Promise<{ id: string; journal: string }> {
  await setNetPay(before);
  const id = await r.calculatedRun(month);
  const first = await r.api.approve(id);
  expect(first.statusCode).toBe(200);
  const journal = String(first.body.data!.journalEntryId);
  await setNetPay(after);
  expect((await r.api.reopen(id)).statusCode).toBe(200);
  expect((await r.api.reverse(journal)).statusCode).toBe(200);
  return { id, journal };
}

beforeAll(async () => {
  r = await rig('net-pay-replacement');
  await r.setup();
  await r.employee(20000);
  c2170 = (await r.pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
     VALUES ($1, '2170', 'Net Salaries Payable', 'liability', 'credit', 1, 'payroll_liability', false) RETURNING id`, [r.company])).rows[0]!.id;
});
afterAll(async () => {
  await r.pool.query('DELETE FROM app_settings WHERE company_id = $1', [r.company]);
  await r.teardown();
});

describe('bank journal reversed, setting now 2170', () => {
  it('the preview and the approval answer both carry the advisory naming the bank and 2170; the replacement credits 2170', async () => {
    const run = await reversedRun(5, null, c2170);
    const preview = await r.api.preview(run.id);
    expect(preview.body.data!.blocker).toBeNull();
    const note = replacedNote(preview.body.data!.plan.advisories);
    expect(note?.detail).toContain('1110');
    expect(note?.detail).toContain('2170 Net Salaries Payable');
    expect(note?.detail).toMatch(/cash leg of .* stays where it was/);

    const ap = await r.api.approveWith(run.id, preview.body.data!.planHash);
    expect(ap.statusCode).toBe(200);
    expect(replacedNote(ap.body.data!.advisories)?.detail).toBe(note?.detail);
    expect(await creditedCodes(String(ap.body.data!.journalEntryId))).toContain('2170');
    expect(await creditedCodes(String(ap.body.data!.journalEntryId))).not.toContain('1110');
  });
});

describe('clearing journal reversed, setting cleared (the bank again)', () => {
  it('the advisory runs the other way, naming 2170 and the bank; the replacement credits the bank', async () => {
    const run = await reversedRun(6, c2170, null);
    const preview = await r.api.preview(run.id);
    expect(preview.body.data!.blocker).toBeNull();
    const note = replacedNote(preview.body.data!.plan.advisories);
    expect(note?.detail).toContain('2170 Net Salaries Payable');
    expect(note?.detail).toContain('1110');
    expect(note?.detail).toMatch(/cash leg of .* stays where it was/);

    const ap = await r.api.approveWith(run.id, preview.body.data!.planHash);
    expect(ap.statusCode).toBe(200);
    expect(replacedNote(ap.body.data!.advisories)).toBeDefined();
    expect(await creditedCodes(String(ap.body.data!.journalEntryId))).toContain('1110');
    expect(await creditedCodes(String(ap.body.data!.journalEntryId))).not.toContain('2170');
  });
});

describe('the target did not change', () => {
  it.each([['the bank', null], ['2170', 'on']])('a journal reversed and replaced on %s carries no advisory', async (_n, which) => {
    const target = which === null ? null : c2170;
    const run = await reversedRun(which === null ? 7 : 8, target, target);
    const preview = await r.api.preview(run.id);
    expect(preview.body.data!.blocker).toBeNull();
    expect(replacedNote(preview.body.data!.plan.advisories)).toBeUndefined();
    const ap = await r.api.approveWith(run.id, preview.body.data!.planHash);
    expect(ap.statusCode).toBe(200);
    expect(replacedNote(ap.body.data!.advisories)).toBeUndefined();
  });
});

describe('a journal still in force', () => {
  it('is the refusal (net_pay_target_changed), which names both accounts and both ways out, and carries no advisory', async () => {
    await setNetPay(null);
    const id = await r.calculatedRun(9);
    expect((await r.api.approve(id)).statusCode).toBe(200);
    await setNetPay(c2170);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toMatchObject({ code: 'net_pay_target_changed' });
    const detail = String(p.body.data!.blocker.detail);
    expect(detail).toContain('1110');
    expect(detail).toContain('2170 Net Salaries Payable');
    expect(detail).toMatch(/set Payroll net pay in Default Accounts back/);
    expect(detail).toMatch(/reverse journal .*: approving then posts a new journal to the account the setting names at that time/);
    expect(replacedNote(p.body.data!.plan.advisories)).toBeUndefined();
  });
});

describe('a journal in force on 2170 whose account has since failed the rules', () => {
  it('the preview shows the plan\'s own net-pay blocker, not net_pay_target_changed or "recalculated"', async () => {
    await setNetPay(c2170);
    const id = await r.calculatedRun(10);
    expect((await r.api.approve(id)).statusCode).toBe(200);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    await r.pool.query(`UPDATE gl_accounts SET account_subtype = 'tax' WHERE id = $1`, [c2170]);
    try {
      const p = await r.api.preview(id);
      expect(p.body.data!.blocker).toMatchObject({ code: 'not_payroll_liability_net_pay_account' });
    } finally {
      await r.pool.query(`UPDATE gl_accounts SET account_subtype = 'payroll_liability' WHERE id = $1`, [c2170]);
    }
    expect((await r.api.preview(id)).body.data!.blocker).toBeNull();
  });
});
