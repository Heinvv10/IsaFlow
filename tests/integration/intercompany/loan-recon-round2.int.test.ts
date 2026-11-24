/**
 * Intercompany P5, review round 2 (MED-1, plan (m).18). S's own loan account also serving another of S's connections: b4 attributes only
 * THIS connection's journals, so the other connection's postings land in own_other, where they can cancel an unrelated partner_other and
 * make U = 0. Repro from B's session: one R400 message matched; B's loan account is also B's side of a B<->C connection; B posts Cr bLoan
 * 700 (a loan from C); A posts Dr aLoan 700 that B never booked. The figures cancel (ownOther -700, partnerOther +700, U = 0), and the
 * summary must NOT reconcile while the account is shared. The control (the same ledger, the account not shared) does reconcile: that is
 * (m).19's accepted limit, two equal-and-opposite hand postings, which balance-to-balance cannot catch (the note shows both figures).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, co, plantExternal, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { acc, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { accepted, ePay, plantJournal, reconConnect, reconSetup, reportAs, reportOf, rowsAs } from './loan-recon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';
beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await setLoanClearing(pool, [co.A, co.B], true);
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await reconConnect(pool);
  await accepted(await ePay(pool, conn, 400));
  // B: a loan FROM C (nothing to do with A) on B's loan account; A: a hand debit B never recorded
  await plantJournal(pool, co.B, '2026-08-01', [[acc.bExp1, 700, 0], [acct.bLoan, 0, 700]], 'P5 r2: loan from C');
  await plantJournal(pool, co.A, '2026-08-01', [[acct.aLoan, 700, 0], [acct.aExpense, 0, 700]], 'P5 r2: A lent B 700, B never booked it');
});

const shareBLoanWithC = async () => {
  const other = await plantExternal(pool, co.B, co.C, 'active');
  await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_guard', (q) => q.query(
    'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, loan_account_id) VALUES ($1, $2, $3, $4)', [other, co.B, co.C, acct.bLoan]));
};

describe("S's own loan account shared with another connection (MED-1)", () => {
  it('the other connection\'s posting cancels an unrelated partner posting: U = 0 but no Reconciles', async () => {
    await shareBLoanWithC();
    const r = await rowsAs(pool, U.b, co.B, conn);
    expect(r.summary.partnerState).toBe('ok');
    expect(r.summary.own?.loanShared).toBe(true);
    expect(r.summary.unexplained).toEqual({ total: 0, ownOther: -700, partnerOther: 700, residualOwn: 0, residualPartner: 0 });
    expect(r.summary.blockingRows).toBe(0);
    expect(r.summary.reconciles).toBe(false);
    // the API answers the same
    const api = reportOf(await reportAs(U.b, co.B, conn));
    expect(api.summary.reconciles).toBe(false);
    expect(api.summary.own?.loanShared).toBe(true);
  });

  it('control: the same ledger with the account NOT shared reconciles (equal-and-opposite hand postings, (m).19)', async () => {
    const r = await rowsAs(pool, U.b, co.B, conn);
    expect(r.summary.own?.loanShared).toBe(false);
    expect(r.summary.unexplained).toEqual({ total: 0, ownOther: -700, partnerOther: 700, residualOwn: 0, residualPartner: 0 });
    expect(r.summary.reconciles).toBe(true);
  });
});
