/**
 * Re-approving a reopened run whose journal is still IN FORCE, after the
 * company's bank role moved (or lost its holder).
 *
 * The approval gate compared the plan with the journal in force account by
 * account, and the plan's net-pay credit names TODAY's bank-role holder while
 * the journal names whoever held the role when it posted. So an UNCHANGED run
 * read as `recalculated_after_posting` ("reverse the journal first") with a
 * false cause, and reversing then crediting a different bank than the cash left
 * from was no remedy. Net pay's bank credit is compared as one role, by amount
 * (payrollLabourComparison#foldNetPayBank): an unchanged run re-locks onto its
 * posted journal and posts nothing; a changed net amount is still refused.
 *
 * Real routes (withAuth, app_user, RLS) and the real GL poster; disposable DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let salaryRow = '';

/** The accounts credited on a journal, with cents. */
const credits = async (journalId: string): Promise<Record<string, number>> => Object.fromEntries((await r.pool.query(
  `SELECT a.account_code, round(l.credit * 100)::int AS c FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 AND l.credit > 0`, [journalId])).rows.map((x) => [x.account_code, x.c]));
const liveJournals = async (): Promise<number> => Number((await r.pool.query(
  `SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted' AND reversed_at IS NULL AND reversal_of_id IS NULL
      AND description LIKE 'Payroll run %'`, [r.company])).rows[0]!.n);
const flag = async (code: string, patch: { system?: boolean; active?: boolean }) => {
  await r.pool.query(
    `UPDATE gl_accounts SET is_system_account = COALESCE($3, is_system_account), is_active = COALESCE($4, is_active)
      WHERE company_id = $1 AND account_code = $2`, [r.company, code, patch.system ?? null, patch.active ?? null]);
  clearSystemAccountCache(r.company);
};

beforeAll(async () => {
  r = await rig('reapprove-bank-role');
  await r.setup(); // 1110 holds the bank role
  salaryRow = (await r.employee(20000)).salaryRow;
  await r.pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account, is_active)
     VALUES ($1, '1544331', 'ABSA Cheque', 'asset', 'debit', 1, 'bank', false, true)`, [r.company]);
});
afterAll(async () => { await r.teardown(); });

describe('re-approval onto an in-force journal after the bank role moved', () => {
  it('unchanged run, role moved to another account: re-locks onto the posted journal and posts nothing', async () => {
    const id = await r.calculatedRun(1);
    const first = await r.api.approve(id);
    expect(first.statusCode).toBe(200);
    const j1 = String(first.body.data!.journalEntryId);
    expect(Object.keys(await credits(j1))).toContain('1110');
    expect((await r.api.reopen(id)).statusCode).toBe(200);

    await flag('1110', { system: false, active: false });
    await flag('1544331', { system: true });

    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toBeNull();
    const again = await r.api.approveWith(id, p.body.data!.planHash);
    expect(again.statusCode).toBe(200);
    expect(String(again.body.data!.journalEntryId)).toBe(j1);
    expect(await liveJournals()).toBe(1);
    expect(Object.keys(await credits(j1))).toContain('1110');
    expect((await r.header(id)).status).toBe('approved');
  });

  it('unchanged run, no account holds the role at all: still re-locks', async () => {
    const id = await r.calculatedRun(2);
    const first = await r.api.approve(id); // posts to 1544331, the holder
    expect(first.statusCode).toBe(200);
    const j = String(first.body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    await flag('1544331', { active: false });

    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toBeNull();
    const again = await r.api.approveWith(id, p.body.data!.planHash);
    expect(again.statusCode).toBe(200);
    expect(String(again.body.data!.journalEntryId)).toBe(j);
    expect(await liveJournals()).toBe(2);
    await flag('1544331', { active: true });
  });

  it('a changed net amount is still refused as recalculated_after_posting after the role moved', async () => {
    const id = await r.calculatedRun(3);
    const first = await r.api.approve(id); // posts to 1544331
    expect(first.statusCode).toBe(200);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    await r.setSalary(salaryRow, 30000);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    await flag('1544331', { system: false });
    await flag('1110', { system: true, active: true });

    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    const refused = await r.api.approveWith(id, p.body.data!.planHash);
    expect(refused.statusCode).toBe(400);
    expect(await liveJournals()).toBe(3);
    await r.setSalary(salaryRow, 20000);
  });
});
