/**
 * WP2 row 5 (Hein's decision): a bank line coded to an ACCOUNT whose contra is another BANK account is a transfer.
 *
 * Coded as an account it went through the account arm — no duplicate guard, no pair lock, no leg pairing — so the
 * other bank's line coded the same way (or a transfer rule on each bank) posted the movement twice. Now it goes
 * through the transfer arm wherever it is posted: the screen (bank-transactions-action), the rule sweep (a rule onto a
 * bank account), and the MCP tools and the confidence gate, which reach allocateTransaction. A contra equal to the
 * line's OWN bank would post a journal that moves nothing: 400 on the screen, a counted skip in the sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, plantLine, refusalOf, type BankCompany } from './bank-controls-a.helpers';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '../../src/lib/auth';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => { a = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET allocation_rule_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const lineOn = async (f: BankCompany, bank: string, amount: number, date: string, description = 'BCT line') => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
   VALUES($1,$2,$3::DATE,$4,$5,'imported') RETURNING id`, [f.c, bank, date, amount, description])).rows[0].id as string;
const transfers = async (f: BankCompany) => (await pool.query(
  `SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted'`, [f.c])).rows[0].n as number;
const state = async (id: string) => (await pool.query(
  `SELECT b.status, b.allocation_type AS type, l.journal_entry_id::TEXT AS je, l.gl_account_id::TEXT AS leg
   FROM bank_transactions b LEFT JOIN gl_journal_lines l ON l.id = b.matched_journal_line_id WHERE b.id = $1`, [id])).rows[0] as
  { status: string; type: string | null; je: string | null; leg: string | null };
const allocateAccount = (f: BankCompany, line: string, contra: string) =>
  act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: contra });

describe('the screen: an account allocation onto a bank account is a transfer', () => {
  it('A→B coded as an account posts ONE transfer and pairs B\'s line; B→A coded as an account is then refused', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const lineA = await lineOn(f, f.bank, -500, '2026-09-01');
    const lineB = await lineOn(f, f.bank2, 500, '2026-09-01');
    const res = await allocateAccount(f, lineA, f.bank2);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const sa = await state(lineA);
    expect(sa).toMatchObject({ status: 'allocated', type: 'transfer', leg: f.bank });
    // The counterparty leg auto-linked to the same journal's bank-2 leg: one movement, both legs paired.
    expect(await state(lineB)).toMatchObject({ status: 'allocated', type: 'transfer', je: sa.je, leg: f.bank2 });
    expect(refusalOf(await allocateAccount(f, lineB, f.bank)).status).toBe(400);
    expect(await transfers(f)).toBe(1);
  });

  it('B→A coded as an account when B was not paired: refused as the existing transfer, still one journal', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const lineA = await lineOn(f, f.bank, -700, '2026-09-01');
    const lineB = await lineOn(f, f.bank2, 700, '2026-09-04'); // 3 days on: outside the auto-link's ±2 days
    expect((await allocateAccount(f, lineA, f.bank2)).state.statusCode).toBe(200);
    expect((await state(lineB)).status).toBe('imported');
    const refused = refusalOf(await allocateAccount(f, lineB, f.bank));
    expect(refused).toMatchObject({ status: 400, message: expect.stringMatching(/A matching transfer already exists/) });
    expect({ b: (await state(lineB)).status, journals: await transfers(f) }).toEqual({ b: 'imported', journals: 1 });
  });

  it('the line\'s own bank as the contra is refused 400, nothing written', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await plantLine(pool, f, null, -90);
    const refused = refusalOf(await allocateAccount(f, line, f.bank));
    expect(refused).toMatchObject({ status: 400, message: expect.stringMatching(/own bank account/) });
    expect({ line: (await state(line)).status, journals: await transfers(f) }).toEqual({ line: 'imported', journals: 0 });
  });
});

describe('the rule sweep: a rule onto a bank account posts a transfer', () => {
  const rule = (f: BankCompany, pattern: string, gl: string) => pool.query(
    `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern, gl_account_id,
       auto_create_entry, created_by) VALUES($1,$2,'description','contains',$3,$4,true,$5)`, [f.c, `BCT ${pattern}`, pattern, gl, a]);
  const apply = async (f: BankCompany, bankAccountId: string) => {
    const res = await callRoute(bankRulesAction as never, tokens[a]!, f.c, 'POST', { action: 'apply', bankAccountId },
      '/api/accounting/bank-rules-action');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    return (res.state.body as { data: Record<string, number> }).data;
  };

  it('one transfer rule per bank, both swept: ONE journal, the legs paired, no second posting', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    await rule(f, 'SWEEP XFER', f.bank2);
    await rule(f, 'SWEEP XFER', f.bank);
    const lineA = await lineOn(f, f.bank, -300, '2026-09-02', 'SWEEP XFER one');
    const lineB = await lineOn(f, f.bank2, 300, '2026-09-02', 'SWEEP XFER one');
    expect(await apply(f, f.bank)).toMatchObject({ applied: 1 });
    expect(await apply(f, f.bank2)).toMatchObject({ applied: 0 });
    const sa = await state(lineA);
    expect(sa).toMatchObject({ status: 'allocated', type: 'transfer' });
    expect(await state(lineB)).toMatchObject({ status: 'allocated', je: sa.je });
    expect(await transfers(f)).toBe(1);
  });

  it('the other bank\'s rule finds the movement already posted (not pairable): a counted skip, still one journal', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    await rule(f, 'LATE XFER', f.bank2);
    await rule(f, 'LATE XFER', f.bank);
    await lineOn(f, f.bank, -400, '2026-09-02', 'LATE XFER');
    const lineB = await lineOn(f, f.bank2, 400, '2026-09-06', 'LATE XFER');
    expect(await apply(f, f.bank)).toMatchObject({ applied: 1 });
    expect(await apply(f, f.bank2)).toMatchObject({ applied: 0, autoPostSkippedDuplicateTransfer: 1 });
    expect({ b: (await state(lineB)).status, journals: await transfers(f) }).toEqual({ b: 'imported', journals: 1 });
  });

  it('a rule onto the swept bank itself posts nothing: a counted skip', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    await rule(f, 'SELF XFER', f.bank);
    const line = await lineOn(f, f.bank, -50, '2026-09-03', 'SELF XFER');
    expect(await apply(f, f.bank)).toMatchObject({ applied: 0, autoPostSkippedOwnBankContra: 1 });
    expect({ line: (await state(line)).status, journals: await transfers(f) }).toEqual({ line: 'imported', journals: 0 });
  });
});

describe('the confidence gate: a suggestion onto a bank account posts a transfer', () => {
  const categorise = withAuth(async (req: CompanyAuthedRequest, res: NextApiResponse) => {
    res.status(200).json({ data: await sweep(req.companyId, req.body.ids as string[], 'categorization', req.user.id, req.user.id) });
  });
  const run = async (f: BankCompany, ids: string[]) => {
    const res = await callRoute(categorise as never, tokens[a]!, f.c, 'POST', { ids }, '/api/accounting/smart-categorize');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    return (res.state.body as { data: { posted: number; skipped: { txId: string; reason: string }[] } }).data;
  };

  it('posts the bank-contra suggestion as a transfer, and skips one onto the line\'s own bank', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
      llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
    const toOther = await lineOn(f, f.bank, -260, '2026-09-05', 'GATE XFER');
    const toSelf = await lineOn(f, f.bank, -261, '2026-09-05', 'GATE SELF');
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [toOther, f.bank2]);
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [toSelf, f.bank]);
    const out = await run(f, [toOther, toSelf]);
    expect(out.posted).toBe(1);
    expect(out.skipped).toEqual([{ txId: toSelf, reason: expect.stringMatching(/own bank account/) }]);
    expect(await state(toOther)).toMatchObject({ status: 'allocated', type: 'transfer', leg: f.bank });
    expect((await state(toSelf)).status).toBe('imported');
  });
});
