/**
 * BREAKER #684 ROUND 2 (head bf371012) — the slice-a repros, kept from
 * brk684r2-round2.int.test.ts (its R2-2/3/5 are slice b's).
 *
 * R2-1 (MEDIUM): auto_match matched the importer's own line to the importer's
 *   own journal (fixed: autoMatchTransactions acts for the person who ran it).
 * R2-6 (MEDIUM): the match gate judged every journal on the manual-journal
 *   arm; a supplier payment's leg is the supplier_payment arm (fixed: the arm
 *   and the creator come from what the line is matched to, allocationFacts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { journalRoutes, plantJournal } from './r035-pr6.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine, refusalOf } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
let act: ReturnType<typeof actionRoute>;
const j = journalRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
  act = actionRoute(tokens);
});
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE supplier_payments SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, Object.values(u));
});

describe('R2-1 — auto_match settles the importer\'s own line against their own journal', () => {
  it('match is refused 403 (the round-1 fix); auto_match matches the same pair', async () => {
    const f = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'admin']], companies);
    await plantRule(pool, f.c, 'owner', { documentType: 'manual_journal', operator: 'greater_than', value: 1000 });
    await enforce(pool, f.c, u.b, ['manual_journal']);
    // autoMatch pairs a deposit with a CREDIT on the bank (utils/autoMatch); match itself checks no direction, so the
    // explicit match below refuses exactly the pair auto_match takes.
    const line = await plantLine(pool, f, await plantBatch(pool, f, u.a), 500);
    const je = await plantJournal(pool, f, u.a, { amount: 500 });
    expect((await j.post(u.a, f.c, je)).state.statusCode).toBe(200);
    const bankLeg = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2',
      [je, f.bank])).rows[0].id as string;
    // Sanity: the round-1 fix refuses the explicit match.
    expect(refusalOf(await act(u.a, f.c, { action: 'match', bankTransactionId: line, journalLineId: bankLeg })))
      .toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });

    const res = await act(u.a, f.c, { action: 'auto_match', bankAccountId: f.bank });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    // REQUIRED (decision 2, as the match fix reads it): the importer's own line is not settled to the importer's own journal.
    expect(await lineStatus(pool, line)).toBe('imported');
  });
});

describe('R2-6 — the match gate judges every journal on the manual-journal arm only', () => {
  it('supplier_payment enforced: the importer may not pay a supplier from their own line, but matches it to their own payment', async () => {
    const f = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'admin']], companies);
    const line = await plantLine(pool, f, await plantBatch(pool, f, u.a), -500);
    // a's own supplier payment (processed, under any threshold), its journal DR AP / CR bank, created by a.
    const ap = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable'", [f.c])).rows[0].id;
    const je = await plantJournal(pool, f, u.a, { amount: 500 });
    await pool.query('UPDATE gl_journal_lines SET gl_account_id = $2 WHERE journal_entry_id = $1 AND debit > 0', [je, ap]);
    expect((await j.post(u.a, f.c, je)).state.statusCode).toBe(200);
    await pool.query(`INSERT INTO supplier_payments(company_id, supplier_id, payment_date, total_amount, payment_method, status,
        gl_journal_entry_id, created_by, processed_at) VALUES($1,$2,DATE '2026-09-01',500,'eft','processed',$3,$4,now())`,
      [f.c, f.supplier, je, u.a]);
    await enforce(pool, f.c, u.b, ['supplier_payment', 'payment_batch']);
    // Sanity: on the supplier arm the importer is refused.
    expect(refusalOf(await act(u.a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'supplier', entityId: f.supplier })))
      .toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
    const bankLeg = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2',
      [je, f.bank])).rows[0].id as string;
    const res = await act(u.a, f.c, { action: 'match', bankTransactionId: line, journalLineId: bankLeg });
    expect({ status: res.state.statusCode, line: await lineStatus(pool, line) }).toEqual({ status: 403, line: 'imported' });
    expect(refusalOf(res)).toMatchObject({ reason: 'IMPORTER_MAY_NOT_ALLOCATE',
      message: expect.stringMatching(/while supplier-payment approval is on/) });
    // A colleague's run, or a colleague matching it, is not the importer's: allowed.
    expect((await act(u.b, f.c, { action: 'match', bankTransactionId: line, journalLineId: bankLeg })).state.statusCode).toBe(200);
  });
});
