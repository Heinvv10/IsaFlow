/**
 * K-083 RED. `postPeriodJournals`
 * (git show origin/master:src/modules/accounting/services/loans/loanGlPostingService.ts,
 * lines 146-207) checks the loan exists, the schedule row exists, the NCA flag
 * and the period lock — and then posts. It never asks whether this loan/period
 * already has a journal, `loan_gl_postings` carries no unique key over
 * (company_id, loan_id, period) (only two plain btree indexes), and nothing
 * takes a row lock.
 *
 * So calling the endpoint twice for the same period — POST
 * /api/accounting/loans/[id]/gl-postings, or a re-run of
 * /api/accounting/loans/period-close — posts the interest and capital journals
 * twice: interest expense and the loan liability are both doubled.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  accounts, company, companyB, dropFixture, loan, loanB, pool, postPeriod, seedFixture,
} from './k083-loan-period-journal.helpers';

assertDisposable();

beforeAll(seedFixture);
afterAll(dropFixture);

it('posting the same loan period twice leaves one journal, not two', async () => {
  const first = await postPeriod();
  expect(first.ok).toBe(true);

  const second = await postPeriod();
  // Refusing the repeat or returning the existing entry are both fine; posting
  // a second set of journals is not.
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [company]);
  expect(rows[0].interest_debited).toBe(1000);

  const posts = await pool.query(
    'SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings WHERE company_id=$1 AND loan_id=$2 AND period=1',
    [company, loan]);
  expect(posts.rows[0].n).toBe(1);
  expect(second.ok).toBe(false);
  // The service refuses it by name. Falling through to the exclusion constraint
  // would also keep the ledger right, but surfaces an opaque 23P01 to the caller.
  expect(String((second as { err: unknown }).err)).toMatch(/has already been posted/);
});

it('leaves a second tenant free to post the same period on its own loan', async () => {
  const b = await postPeriod(1, companyB, loanB);
  expect(b.ok).toBe(true);

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [companyB]);
  expect(rows[0].interest_debited).toBe(1000);

  // Company A's ledger is untouched by company B's post.
  const a = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [company]);
  expect(a.rows[0].interest_debited).toBe(1000);
});

it('a reversal row is not itself a posting and does not block its own period', async () => {
  // Review M1. The earlier version of this test inserted a reversal row for a
  // period that never had an original, so it could not tell the two behaviours
  // apart. Period 2 has no original here either — what it proves is only that a
  // row carrying reversal_of is not mistaken for a posting.
  const seed = await pool.query(
    `SELECT id FROM loan_gl_postings WHERE company_id=$1 AND loan_id=$2 AND period=1 LIMIT 1`,
    [company, loan]);
  await pool.query(
    `INSERT INTO loan_gl_postings(company_id,loan_id,period,posting_date,account_id,debit,credit,
       narrative,posted_period,journal_entry_id,reversal_of)
     VALUES($1,$2,2,'2026-03-31',$3,0,921.15,'reversal','202603',NULL,$4)`,
    [company, loan, accounts['8100'], seed.rows[0].id]);

  const posted = await postPeriod(2);
  expect(posted.ok).toBe(true);

  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=2 AND reversal_of IS NULL`, [company, loan]);
  expect(rows[0].n).toBe(1);
});

it('reversing the GL journal does NOT let the period be re-posted', async () => {
  // Review M1. Reversing a journal writes to gl_journal_entries only; the
  // original loan_gl_postings rows keep reversal_of IS NULL and keep blocking.
  // The code comment, fix.md, the migration header and the module docs used to
  // claim the opposite. This pins the behaviour that actually exists.
  const first = await postPeriod(4);
  expect(first.ok).toBe(true);

  const original = await pool.query(
    `SELECT id, journal_entry_id FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=4 AND reversal_of IS NULL`, [company, loan]);
  expect(original.rowCount).toBeGreaterThan(0);

  // Mark every original row as reversed, the way a GL reversal would if it
  // touched this table at all.
  await pool.query(
    `INSERT INTO loan_gl_postings(company_id,loan_id,period,posting_date,account_id,debit,credit,
       narrative,posted_period,journal_entry_id,reversal_of)
     SELECT company_id,loan_id,period,posting_date,account_id,credit,debit,
            'reversal',posted_period,NULL,id
       FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=4 AND reversal_of IS NULL`,
    [company, loan]);

  const retry = await postPeriod(4);
  expect(retry.ok).toBe(false);
  expect(String((retry as { err: unknown }).err)).toMatch(/has already been posted/);

  // The documented remediation: delete the superseded rows, then it posts.
  await pool.query(
    `DELETE FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=4`, [company, loan]);

  const afterCleanup = await postPeriod(4);
  expect(afterCleanup.ok).toBe(true);
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=4 AND reversal_of IS NULL`, [company, loan]);
  expect(rows[0].n).toBe(1);
});

it('treats a row with no journal id the same way the constraint does', async () => {
  // Review L4. The exclusion constraint's predicate carries
  // `journal_entry_id IS NOT NULL`, so a row without one is unconstrained. The
  // service guard used to omit that test and treat such a row as an existing
  // post, leaving the two layers disagreeing about the same table.
  await pool.query(
    `INSERT INTO loan_gl_postings(company_id,loan_id,period,posting_date,account_id,debit,credit,
       narrative,posted_period,journal_entry_id,reversal_of)
     VALUES($1,$2,5,'2026-06-30',$3,761.08,0,'orphan line','202606',NULL,NULL)`,
    [company, loan, accounts['8100']]);

  const posted = await postPeriod(5);
  expect(posted.ok).toBe(true);

  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=5
        AND reversal_of IS NULL AND journal_entry_id IS NOT NULL`, [company, loan]);
  expect(rows[0].n).toBe(1);
});

it('lets only one of two concurrent posts through', async () => {
  // Measure the delta rather than a running total: earlier tests in this file
  // post other periods, and an absolute figure here would be asserting their
  // behaviour as much as this one's.
  const before = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [company]);

  const [first, second] = await Promise.all([postPeriod(3), postPeriod(3)]);
  const outcomes = [first.ok, second.ok].sort();
  expect(outcomes).toEqual([false, true]);

  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=3 AND reversal_of IS NULL`, [company, loan]);
  expect(rows[0].n).toBe(1);

  // Period 3's interest was debited exactly once despite two parallel posts.
  const gl = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [company]);
  expect(gl.rows[0].interest_debited - before.rows[0].interest_debited).toBeCloseTo(841.51, 2);
});
