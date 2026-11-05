/**
 * Net pay is credited to the account holding the company's BANK system role,
 * not to the literal code '1110'.
 *
 * Velocity Fibre, 2026-10-27: 1110 was deactivated and the role moved to
 * 1544331 (ABSA). The plan kept crediting 1110, so the October run carried
 * `inactive_target_account` and could never be approved. Taken through the real
 * routes and the real GL poster: the posted journal_lines (not the preview) hit
 * the role holder, and a company with no active holder is refused with a named
 * blocker and writes nothing.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;

/** Credits to `code` on the journal, in cents. */
const credited = async (journalId: string, code: string): Promise<number[]> => (await r.pool.query(
  `SELECT round(l.credit * 100)::int AS c FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 AND a.account_code = $2 AND l.credit > 0`, [journalId, code])).rows.map((x) => x.c as number);

beforeAll(async () => {
  r = await rig('bank-role');
  await r.setup(); // 1110 is the bank role holder, as on every seeded chart
  await r.employee(20000);
});
afterAll(async () => { await r.teardown(); });

describe('payroll net pay and the bank system role', () => {
  it('regression: while 1110 holds the role, net pay posts to 1110', async () => {
    const id = await r.calculatedRun(1);
    const net = Math.round((await r.header(id)).net * 100);
    const ap = await r.api.approve(id);
    expect(ap.statusCode).toBe(200);
    expect(await credited(String(ap.body.data!.journalEntryId), '1110')).toEqual([net]);
  });

  it('role moved off 1110 (deactivated): the plan is not blocked and the POSTED journal credits the role holder', async () => {
    const id = await r.calculatedRun(2);
    const net = Math.round((await r.header(id)).net * 100);
    await r.pool.query("UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_code = '1110'", [r.company]);
    await r.pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
       VALUES ($1, '1544331', 'ABSA Cheque', 'asset', 'debit', 1, 'bank', true)`, [r.company]);
    clearSystemAccountCache(r.company);

    const preview = await r.api.preview(id);
    expect(preview.statusCode).toBe(200);
    expect(preview.body.data!.blocker).toBeNull();
    const ap = await r.api.approve(id);
    expect(ap.statusCode).toBe(200);
    const journal = String(ap.body.data!.journalEntryId);
    expect(await credited(journal, '1544331')).toEqual([net]);
    expect(await credited(journal, '1110')).toEqual([]);
  });

  it('no active account holds the role: refused with missing_bank_account, nothing posted, never a 1110 fallback', async () => {
    const id = await r.calculatedRun(3);
    await r.pool.query("UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_code = '1544331'", [r.company]);
    clearSystemAccountCache(r.company);

    const preview = await r.api.preview(id);
    expect(preview.body.data!.blocker).toMatchObject({ code: 'missing_bank_account' });
    expect(JSON.stringify(preview.body.data!.blocker)).toMatch(/Default Accounts/);
    const ap = await r.api.approve(id);
    expect(ap.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(ap.body)).toMatch(/bank role/);
    const h = await r.header(id);
    expect([h.status, h.journal_entry_id]).toEqual(['calculated', null]);
  });

  it('two active accounts claim the role: refused naming both, nothing posted', async () => {
    const id = await r.calculatedRun(4);
    await r.pool.query("UPDATE gl_accounts SET is_active = true WHERE company_id = $1 AND account_code = '1544331'", [r.company]);
    await r.pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
       VALUES ($1, '1555', 'Nedbank Cheque', 'asset', 'debit', 1, 'bank', true)`, [r.company]);
    clearSystemAccountCache(r.company);

    const preview = await r.api.preview(id);
    expect(preview.body.data!.blocker).toMatchObject({ code: 'ambiguous_bank_account' });
    const detail = JSON.stringify(preview.body.data!.blocker);
    expect(detail).toContain('1544331');
    expect(detail).toContain('1555');
    expect((await r.api.approve(id)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await r.header(id)).journal_entry_id).toBeNull();
    await r.pool.query("DELETE FROM gl_accounts WHERE company_id = $1 AND account_code = '1555'", [r.company]);
  });

  it('the holder is a header with sub-accounts: refused up front, as the poster would refuse it', async () => {
    const id = await r.calculatedRun(5);
    const parent = (await r.pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '1544331'", [r.company])).rows[0]!.id;
    await r.pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, parent_account_id, account_subtype)
       VALUES ($1, '1544331-1', 'ABSA sub', 'asset', 'debit', 2, $2, 'other')`, [r.company, parent]);
    clearSystemAccountCache(r.company);

    const preview = await r.api.preview(id);
    expect(preview.body.data!.blocker).toMatchObject({ code: 'header_bank_account' });
    expect((await r.api.approve(id)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await r.header(id)).journal_entry_id).toBeNull();
  });
});
