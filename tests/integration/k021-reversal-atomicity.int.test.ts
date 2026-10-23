// K-021 adjacent cases for the atomicity of `reverseReconciledTransaction`.
//
// The RED test (k021-failed-reversal-commits-unwind.int.test.ts) is stopped by
// the pre-flight, so it never reaches the savepoint. These do:
//   1. a contra that fails for a reason the pre-flight CANNOT see (the original
//      is already reversed) — the savepoint is the only thing that unwinds the
//      unwind;
//   2. the successful reversal, so the fix did not turn a working path into a
//      refusal: balanced contra, and the subledger agrees with it;
//   3. another tenant's reversal of the same bank line, refused with nothing
//      written;
//   4. (D8 round 4) a journal whose reversal chain is genuinely OUT — a real
//      posted contra stands against it — frees the line and posts nothing. The
//      forged case 1 (stamped, NO contra) is a broken chain and still refuses.
// The fallback-date period cases are in k021-reversal-atomicity-periods.int.test.ts;
// the shared tenant and fixtures in k021-reversal-atomicity.helpers.ts.
// Every refusal here is a 4xx, which `withAuth` COMMITs — so "nothing written"
// is a claim about the database after the commit, not about an aborted tx.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k021World, newFixture, oldDate, UNTOUCHED } from './k021-reversal-atomicity.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const w = k021World(pool);
const { company, user, bank, arControl, oldPeriod, tokens } = w;

const alreadyReversed = newFixture();
const happyPath = newFixture();
const crossTenant = newFixture();
const outChain = newFixture();
const fixtures = [alreadyReversed, happyPath, crossTenant, outChain];

beforeAll(async () => {
  await w.seed([
    [alreadyReversed, 'already-reversed'], [happyPath, 'happy'], [crossTenant, 'cross-tenant'], [outChain, 'out-chain'],
  ]);

  // Only the first fixture's journal is already reversed. reverseJournalEntry
  // refuses on `reversed_at`, and it refuses AFTER the unwind has written.
  await pool.query('UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = $2 WHERE id = $1',
    [alreadyReversed.je, user]);
  // outChain: a REAL posted contra (as reverseJournalEntry leaves one), so its chain is out.
  const contra = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by,source,reversal_of_id)
     VALUES($1,$2,$5::date,'K021A out-chain contra','posted',$3,$4,NOW(),$3,'auto_bank_recon',$6)`,
    [contra, company, user, oldPeriod, oldDate, outChain.je]);
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,0,1000),($1,$2,$4,1000,0)`, [company, contra, bank, arControl]);
  await pool.query('UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = $2 WHERE id = $1', [outChain.je, user]);
});

afterAll(() => w.teardown(fixtures));

describe('K-021 reversal atomicity', () => {
  it('rolls the unwind back when the contra fails for a reason the pre-flight cannot see', async () => {
    // The period is open, so the pre-flight passes and the unwind RUNS. Only
    // the savepoint puts the invoice, the payment and the allocation back.
    const result = await w.reverse(alreadyReversed.bankTx, tokens.token, company);
    expect(result.state.statusCode).not.toBe(200);
    expect(await w.readState(alreadyReversed)).toEqual(UNTOUCHED);
  });

  it('still reverses cleanly when the contra can post, and the contra balances', async () => {
    const result = await w.reverse(happyPath.bankTx, tokens.token, company);
    expect(result.state.statusCode).toBe(200);
    expect(await w.readState(happyPath)).toEqual({
      bankTxStatus: 'imported',
      invoiceAmountPaid: 0,
      invoiceStatus: 'approved',
      paymentStatus: 'cancelled',
      allocationRows: 0,
      reversalJournals: 1,
    });

    // The contra is balanced AND mirrors the original leg for leg: the credit
    // that comes off the bank equals the debit put back on AR control, and the
    // invoice the subledger just reopened is owed exactly that again.
    const lines = await pool.query(
      `SELECT jl.gl_account_id, SUM(jl.debit)::numeric AS dr, SUM(jl.credit)::numeric AS cr
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
       WHERE je.company_id=$1 AND je.reversal_of_id=$2 GROUP BY jl.gl_account_id`,
      [company, happyPath.je]);
    const byAccount = new Map(lines.rows.map((r) => [r.gl_account_id, { dr: Number(r.dr), cr: Number(r.cr) }]));
    expect(byAccount.get(bank)).toEqual({ dr: 0, cr: 1000 });
    expect(byAccount.get(arControl)).toEqual({ dr: 1000, cr: 0 });
    const totals = [...byAccount.values()].reduce((a, l) => ({ dr: a.dr + l.dr, cr: a.cr + l.cr }), { dr: 0, cr: 0 });
    expect(totals.dr).toBe(totals.cr);

    const inv = await pool.query(
      'SELECT total_amount - COALESCE(amount_paid,0) AS outstanding FROM customer_invoices WHERE id=$1', [happyPath.invoice]);
    expect(Number(inv.rows[0].outstanding)).toBe(byAccount.get(arControl)!.dr);
  });

  it('refuses a second reversal of the same line without posting a second contra', async () => {
    // Retry of the call that just succeeded: the bank line is back to
    // 'imported', which is not a reversible status.
    const result = await w.reverse(happyPath.bankTx, tokens.token, company);
    expect(result.state.statusCode).not.toBe(200);
    expect((await w.readState(happyPath)).reversalJournals).toBe(1);
  });

  it('refuses another tenant and leaves the line untouched', async () => {
    const result = await w.reverse(crossTenant.bankTx, tokens.otherToken, w.otherCompany);
    expect(result.state.statusCode).not.toBe(200);
    expect(await w.readState(crossTenant)).toEqual(UNTOUCHED);
  });

  it('frees the line and posts nothing when the journal\'s chain is already OUT (D8 round 4)', async () => {
    const result = await w.reverse(outChain.bankTx, tokens.token, company);
    expect(result.state.statusCode).toBe(200);
    // Subledger unwound like the happy path; the only contra is the one already there.
    expect(await w.readState(outChain)).toEqual({
      bankTxStatus: 'imported', invoiceAmountPaid: 0, invoiceStatus: 'approved',
      paymentStatus: 'cancelled', allocationRows: 0, reversalJournals: 1,
    });
  });
});
