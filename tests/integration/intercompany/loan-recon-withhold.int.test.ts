/**
 * Intercompany P5: the partner-consent gate b0 ((k).1, (k).3, (l).2, (l).3). With the partner's flag off, the connection revoked, the partner
 * out of the group, the connection external, S's own loan account unset or a header, or the partner's loan account NULL / a header / shared
 * with the partner's connection to a third company: the partner's figures AND every partner-fact column of b3 are NULL, S's own figures do
 * not move, there is no badge, and the API answers difference, components, unexplained, reconciles as null and every row's bucket as null (no
 * identity runs, no 500). The three partner_setup cases answer identically. The ORDER: the relationship first, so an ex-partner never learns
 * the partner's flag or set-up (revoked / external / out of the group with the partner's flag off AND its loan account NULL answer the same
 * word as with both in place).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, co, plantExternal, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import {
  accepted, ePay, errorText, forgeConnection, forgeSide, opening, PARTNER_FACTS, rawMessages, rawSummary, reconConnect, reconSetup, reportAs,
  reportOf,
} from './loan-recon.helpers';
import type { PartnerState, ReconReport } from '../../../src/modules/accounting/services/intercompany/loanReconTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';
let base: ReconReport;
let msg = '';

beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await setLoanClearing(pool, [co.A, co.B], true);
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await reconConnect(pool);
  await opening(pool, 1000, 1000);
  const m = await ePay(pool, conn, 400);
  await accepted(m);
  await ePay(pool, conn, 150);
  msg = m.message;
  base = reportOf(await reportAs(U.b, co.B, conn, { section: 'undone' }));
  expect(base.summary.partnerState).toBe('ok');
});

/** A's side's loan account becomes a header (a child account added under it). */
const headerA = async () => pool.query(
  `INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype, parent_account_id)
   VALUES ($1, $2, 'P5 child', 'asset', 'debit', true, 'other_current_asset', $3)`, [co.A, `RLC${crypto.randomUUID().slice(0, 8)}`, acct.aLoan]);
/** A's loan account also serves A's (external, active) connection with C. */
const sharedA = async () => {
  const other = await plantExternal(pool, co.A, co.C, 'active');
  await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_guard', (q) => q.query(
    'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, loan_account_id) VALUES ($1, $2, $3, $4)', [other, co.A, co.C, acct.aLoan]));
};
/** A leaves the group while the connection row stays active (the membership trigger, which would revoke it, off): b0 must judge the group
 *  itself, not lean on the revoke. */
const leaveGroup = () => withoutTrigger(pool, 'company_group_members', 'trg_intercompany_group_membership', (q) =>
  q.query('UPDATE company_group_members SET left_date = CURRENT_DATE - 1 WHERE group_id = $1 AND company_id = $2', [co.G, co.A]));

const CASES: [string, PartnerState, () => Promise<unknown>][] = [
  ['the partner flag off', 'partner_flag_off', () => setLoanClearing(pool, [co.A], false)],
  ['the partner flag never set', 'partner_flag_off', () => setLoanClearing(pool, [co.A], null)],
  ['the connection revoked', 'connection_not_active', () => forgeConnection(pool, conn, `status = 'revoked', revoked_at = now(), revoked_by = '${U.ab}'`)],
  ['the partner left the group', 'not_one_group', leaveGroup],
  ['the connection external', 'not_group', () => forgeConnection(pool, conn, "kind = 'external'")],
  ["S's loan account unset", 'loan_unset', () => forgeSide(pool, conn, co.B, 'loan_account_id = NULL')],
  ["the partner's loan account unset", 'partner_setup', () => forgeSide(pool, conn, co.A, 'loan_account_id = NULL')],
  ["the partner's loan account a header", 'partner_setup', headerA],
  ["the partner's loan account shared with its connection to a third company", 'partner_setup', sharedA],
];

describe('the partner withheld', () => {
  it.each(CASES)('%s: %s; partner figures and every partner fact NULL, own figures unchanged, no badge, buckets null', async (_n, state, make) => {
    await make();
    const res = await reportAs(U.b, co.B, conn, { section: 'undone' });
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const r = reportOf(res);
    expect(r.summary).toMatchObject({ partnerState: state, partner: null, difference: null, components: null, unexplained: null, reconciles: null, identityFailures: 0 });
    expect(r.summary.withheld).toMatchObject({ reason: state });
    if (state === 'loan_unset') expect(r.summary.own).toBeNull();
    else expect(r.summary.own).toEqual(base.summary.own);
    expect(r.section.items.every((i) => i.bucket === null && i.contribution === null)).toBe(true);
    const sum = await rawSummary(pool, U.b, co.B, conn);
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ partner_state: state, partner_balance: null, partner_other: null });
    // from B (all out): the receiver's facts; from A (all in, when A's own view still answers): the payer's
    for (const row of await rawMessages(pool, U.b, co.B, conn)) {
      for (const col of PARTNER_FACTS.out) expect(row[col], `${col} of ${String(row.message_id)}`).toBeNull();
      expect(row.payer_state).not.toBeNull();
      // B's own part of loan_account_changed only (its own journal against its own current account): true when B's account is gone
      expect(row.loan_account_changed, String(row.message_id)).toBe(state === 'loan_unset' ? true : null);
    }
  });

  it('the three partner_setup cases answer identically (one generic word, (k).3)', async () => {
    const seen: string[] = [];
    for (const make of [() => forgeSide(pool, conn, co.A, 'loan_account_id = NULL'), headerA, sharedA]) {
      await wipeConnections(pool);
      conn = await reconConnect(pool);
      await opening(pool, 1000, 1000);
      await make();
      const r = reportOf(await reportAs(U.b, co.B, conn));
      seen.push(JSON.stringify({ ...r.summary, own: null }));
    }
    expect(new Set(seen).size).toBe(1);
  });

  it("from the partner's own session the same gates hold: S's facts NULL in X's in-rows when S's flag is off", async () => {
    await setLoanClearing(pool, [co.B], false);
    // A asks: B (its partner) is flag-off, so B's payer facts are withheld from A
    const r = reportOf(await reportAs(U.a, co.A, conn));
    expect(r.summary).toMatchObject({ partnerState: 'partner_flag_off', partner: null, reconciles: null });
    for (const row of await rawMessages(pool, U.a, co.A, conn)) {
      for (const col of PARTNER_FACTS.in) expect(row[col], col).toBeNull();
      expect(row.receiver_state).not.toBeNull();
      expect(row.loan_account_changed).toBeNull();
    }
  });
});

describe('the b0 order ((l).2): the relationship before any fact of the partner', () => {
  const unrelated: [string, PartnerState, () => Promise<unknown>][] = CASES.filter(([, s]) => ['connection_not_active', 'not_group', 'not_one_group'].includes(s));
  it.each(unrelated)('%s with the partner flag off AND its loan account NULL answers %s, as with both in place', async (_n, state, make) => {
    await make();
    const plain = reportOf(await reportAs(U.b, co.B, conn));
    await setLoanClearing(pool, [co.A], false);
    await forgeSide(pool, conn, co.A, 'loan_account_id = NULL');
    const worst = reportOf(await reportAs(U.b, co.B, conn));
    expect(plain.summary.partnerState).toBe(state);
    expect(worst.summary.partnerState).toBe(state);
    expect(JSON.stringify(worst.summary)).toBe(JSON.stringify(plain.summary));
    expect((await rawSummary(pool, U.b, co.B, conn))[0]?.partner_state).toBe(state);
  });

  it("S's own unset loan account comes before the partner's facts", async () => {
    await forgeSide(pool, conn, co.B, 'loan_account_id = NULL');
    await setLoanClearing(pool, [co.A], false);
    expect(reportOf(await reportAs(U.b, co.B, conn)).summary.partnerState).toBe('loan_unset');
  });
});

describe("S's own shared loan account", () => {
  it("own_loan_shared is S's own fact: shown, the partner still ok", async () => {
    const other = await plantExternal(pool, co.B, co.C, 'active');
    await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_guard', (q) => q.query(
      'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, loan_account_id) VALUES ($1, $2, $3, $4)', [other, co.B, co.C, acct.bLoan]));
    const r = reportOf(await reportAs(U.b, co.B, conn));
    expect(r.summary.partnerState).toBe('ok');
    expect(r.summary.own?.loanShared).toBe(true);
    expect(r.summary.unexplained?.total).toBe(base.summary.unexplained?.total);
    expect(msg).toBeTruthy();
  });
});
