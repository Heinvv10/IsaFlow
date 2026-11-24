/**
 * Intercompany P5: the worked example of the plan's section (d), built through the real services (E's clearing route, D's accept route, the
 * receipt's cancel), a pre-gate payer void and a bank-paid payment by fixture, read through the real route as app_user with real tokens.
 * From S's session (B, the payer: every message `out`) AND from X's session (A: every message `in`): the balances swap between the two
 * sessions, while D, every contribution and U are IDENTICAL ((l).1). I0 (one bucket per message), I1 (balance = attributed + other), I2 and
 * the badge hold to the cent. Variant 1 (the partner opened at R49 000) and variant 2 (a batch journal) never show "Reconciles". The own
 * balance is the trial balance's ((j).10).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { getPostedAccountBalance } from '../../../src/modules/accounting/services/gl/glAccountBalance';
import { acct, co, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments, plantBatchRow, plantPaid, sendFor } from './allocation.helpers';
import {
  accepted, bucketsOf, cancelReceipt, componentsOf, ePay, errorText, fixturePaid, itemOf, opening, pair, payable, plantJournal, preGateVoid,
  reconConnect, reconSetup, reportAs, reportOf, rowsAs,
} from './loan-recon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await reconConnect(pool);
});

/** m1-m5 of (d), on top of the hand-posted openings. */
async function workedExample(partnerOpening = 50000) {
  await opening(pool, 50000, partnerOpening);
  const m1 = await ePay(pool, conn, 10000);
  await accepted(m1);
  const m2 = await ePay(pool, conn, 2500);
  const m3 = await ePay(pool, conn, 1200);
  await cancelReceipt(pool, (await accepted(m3)).receipt);
  const m4 = await ePay(pool, conn, 800);
  await accepted(m4);
  await preGateVoid(pool, m4);
  const m5 = await fixturePaid(pool, conn, 300);
  return { m1, m2, m3, m4, m5 };
}

const EXAMPLE_COMPONENTS = {
  matched: { amount: 0, count: 1 }, in_flight: { amount: -2500, count: 1 }, receiver_undone: { amount: -1200, count: 1 },
  payer_undone: { amount: 800, count: 1 }, not_through_loan: { amount: 0, count: 1 },
};

describe('the worked example', () => {
  it("from S's session (B, all out): the balances, D = sum(contrib) = -2 900, U = 0, Reconciles; each message in its bucket", async () => {
    const x = await workedExample();
    const res = await reportAs(U.b, co.B, conn, { section: 'undone' });
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const r = reportOf(res);
    expect(r.summary.own).toEqual({ balance: -63700, attributed: -13700, other: -50000, loanShared: false });
    expect(r.summary.partner).toEqual({ balance: 60800, attributed: 10800, other: 50000 });
    expect(r.summary).toMatchObject({ partnerState: 'ok', withheld: null, difference: -2900, reconciles: true, identityFailures: 0, blockingRows: 0 });
    expect(r.summary.unexplained).toEqual({ total: 0, ownOther: -50000, partnerOther: 50000, residualOwn: 0, residualPartner: 0 });
    expect(componentsOf(r.summary)).toEqual(EXAMPLE_COMPONENTS);
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(r.readAt)).not.toBeNaN();
    // the undone list: m3 (receiver_undone) and m4 (payer_undone), in created order, with S's own documents only
    expect(r.section.items.map((i) => [i.id, i.bucket])).toEqual([[x.m3.message, 'receiver_undone'], [x.m4.message, 'payer_undone']]);
    expect(r.section.total).toBe(2);
    expect(r.section.items[0]!.own).toMatchObject({ billId: x.m3.bill, paymentId: x.m3.payment, invoiceId: null, receiptId: null });
    const rows = await rowsAs(pool, U.b, co.B, conn);
    expect(bucketsOf(rows)).toEqual({
      [x.m1.message]: 'matched', [x.m2.message]: 'in_flight', [x.m3.message]: 'receiver_undone', [x.m4.message]: 'payer_undone', [x.m5.message]: 'not_through_loan',
    });
    // I0: every message once
    expect(rows.items.filter((i) => i.kind === 'message')).toHaveLength(5);
    expect(itemOf(rows, x.m4.message)).toMatchObject({ direction: 'out', payerState: 'payment_not_posted', receiverState: 'clearing_standing', contribution: 800 });
    expect(itemOf(rows, x.m3.message)).toMatchObject({ receiverState: 'clearing_voided', contribution: -1200 });
  });

  it("from X's session (A, all in): the balances swap; D, every contribution and U are the same, not sign-flipped", async () => {
    const x = await workedExample();
    const s = await rowsAs(pool, U.b, co.B, conn);
    const res = await reportAs(U.a, co.A, conn);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const r = reportOf(res);
    expect(r.summary.own).toEqual({ balance: 60800, attributed: 10800, other: 50000, loanShared: false });
    expect(r.summary.partner).toEqual({ balance: -63700, attributed: -13700, other: -50000 });
    expect(r.summary).toMatchObject({ difference: -2900, reconciles: true, identityFailures: 0 });
    expect(r.summary.unexplained).toEqual({ total: 0, ownOther: 50000, partnerOther: -50000, residualOwn: 0, residualPartner: 0 });
    expect(componentsOf(r.summary)).toEqual(EXAMPLE_COMPONENTS);
    const xr = await rowsAs(pool, U.a, co.A, conn);
    for (const m of [x.m1, x.m2, x.m3, x.m4, x.m5]) {
      expect(itemOf(xr, m.message)?.direction).toBe('in');
      expect(itemOf(xr, m.message)?.contribution, m.message).toBe(itemOf(s, m.message)?.contribution);
      expect(itemOf(xr, m.message)?.bucket).toBe(itemOf(s, m.message)?.bucket);
    }
    // A's own documents: its invoice and its receipt, never B's bill or payment
    expect(itemOf(xr, x.m1.message)?.own).toMatchObject({ billId: null, paymentId: null, invoiceId: x.m1.invoice });
    expect(itemOf(xr, x.m1.message)?.own.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('variant 1: the partner posted its opening as R49 000: Unexplained R1 000 (other postings), no Reconciles, from both sessions', async () => {
    await workedExample(49000);
    for (const [user, company] of [[U.b, co.B], [U.a, co.A]] as const) {
      const r = reportOf(await reportAs(user, company, conn));
      expect(r.summary.difference).toBe(-3900);
      expect(r.summary.unexplained?.total).toBe(-1000);
      expect(r.summary.reconciles).toBe(false);
      expect(r.summary.identityFailures).toBe(0);
      expect(componentsOf(r.summary)).toEqual(EXAMPLE_COMPONENTS);
    }
  });

  it('variant 2: a batch journal crediting R5 000 for two pending R2 000 messages: residual -1 000, payer_journal_differs on both, no Reconciles', async () => {
    const je = await plantJournal(pool, co.B, '2026-09-01', [[payable.b, 5000, 0], [acct.bLoan, 0, 5000]], 'P5 batch');
    const batch = await plantBatchRow(pool, { journal: je });
    const sent: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const p = await pair(pool, conn, 2000);
      const paid = await plantPaid(pool, p.bill, { batch, amount: 2000 });
      const out = await sendFor(pool, paid.allocation);
      expect(out.message_id, String(out.reason)).toBeTruthy();
      sent.push(out.message_id!);
    }
    const rows = await rowsAs(pool, U.b, co.B, conn);
    expect(rows.summary.own).toMatchObject({ balance: -5000, attributed: -5000, other: 0 });
    expect(rows.summary.unexplained).toEqual({ total: -1000, ownOther: 0, partnerOther: 0, residualOwn: -1000, residualPartner: 0 });
    expect(rows.summary).toMatchObject({ difference: -5000, reconciles: false, blockingRows: 2, identityFailures: 0 });
    for (const id of sent) expect(itemOf(rows, id)).toMatchObject({ bucket: 'in_flight', payerJournalDiffers: true, contribution: -2000 });
    expect(itemOf(rows, sent[0]!)?.mismatches).toContain('amount');
  });
});

describe('the trial balance', () => {
  it("own_balance is the posted balance of S's loan account, the trial balance's definition, from either session", async () => {
    await workedExample();
    const b = await asService(pool, U.b, co.B, () => getPostedAccountBalance(co.B, acct.bLoan));
    const a = await asService(pool, U.a, co.A, () => getPostedAccountBalance(co.A, acct.aLoan));
    expect(reportOf(await reportAs(U.b, co.B, conn)).summary.own?.balance).toBeCloseTo(b, 2);
    expect(reportOf(await reportAs(U.a, co.A, conn)).summary.own?.balance).toBeCloseTo(a, 2);
    expect([b, a]).toEqual([-63700, 60800]);
  });

  it("a legacy status = 'reversed' journal on the loan account counts in neither the trial balance nor the report", async () => {
    await workedExample();
    const legacy = await plantJournal(pool, co.B, '2026-09-05', [[payable.b, 999, 0], [acct.bLoan, 0, 999]], 'P5 legacy reversed');
    await pool.query("UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1", [legacy]);
    const b = await asService(pool, U.b, co.B, () => getPostedAccountBalance(co.B, acct.bLoan));
    expect(b).toBe(-63700);
    expect(reportOf(await reportAs(U.b, co.B, conn)).summary).toMatchObject({ own: { balance: -63700 }, reconciles: true });
  });
});
