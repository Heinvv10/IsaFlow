/**
 * Intercompany P5: the states and lists the report names ((a), (k).6-(k).8, (l).4, (l).5). Timing: a payer journal dated after today (pending
 * -> payer_timing, 0; accepted with the receipt standing -> payer_timing, +a), a reversal of a standing payer journal dated after today
 * (accepted -> payer_timing, 0, payer_state standing), a receipt dated after today -> timing. Unapply then re-apply on the same journal: m1
 * not_live, m2 in_flight, U = 0. A re-pointed loan account, a migration_admin-forged `withdrawn`. The Needs-attention list: `unsent` (S's own
 * facts only), `unlinked_partner_bill`, `pending_too_long` (7 days), `failed` with its stored sentence. Every case holds I0 and I2.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, co, party, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments, linkBill } from './allocation.helpers';
import { reapply } from './allocation-clear.helpers';
import {
  accepted, dayOf, ePay, fixturePaid, forgeMessage, forgeSide, freshLoans, itemOf, pair, payable, plantJournal, reconConnect, reconSetup,
  reportAs, reportOf, reverseOn, rowsAs,
} from './loan-recon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  // the bills earlier tests paid lost their links with the connection: out of the way, so each test's lists are its own
  await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE company_id = $1 AND deleted_at IS NULL', [co.B]);
  conn = await reconConnect(pool);
});

const rows = () => rowsAs(pool, U.b, co.B, conn);
const healthy = (s: Awaited<ReturnType<typeof rows>>['summary']) => expect(s.identityFailures).toBe(0);

describe('timing ((l).5)', () => {
  it('a payer journal dated after today: pending -> payer_timing, 0; accepted with the receipt standing -> payer_timing, +a', async () => {
    const later = await dayOf(pool, 5);
    const jePending = await plantJournal(pool, co.B, later, [[payable.b, 400, 0], [acct.bLoan, 0, 400]]);
    const pending = await fixturePaid(pool, conn, 400, { journal: jePending });
    const jeAcc = await plantJournal(pool, co.B, later, [[payable.b, 300, 0], [acct.bLoan, 0, 300]]);
    const acc = await fixturePaid(pool, conn, 300, { journal: jeAcc });
    await accepted({ ...acc, journal: jeAcc });
    const r = await rows();
    healthy(r.summary);
    expect(itemOf(r, pending.message)).toMatchObject({ bucket: 'payer_timing', contribution: 0, payerState: 'dated_after' });
    expect(itemOf(r, acc.message)).toMatchObject({ bucket: 'payer_timing', contribution: 300, payerState: 'dated_after', receiverState: 'clearing_standing' });
    // the journals after T are outside the balance at T, so outside the attribution: U = 0
    expect(r.summary.own).toMatchObject({ balance: 0, attributed: 0 });
    expect(r.summary.unexplained?.total).toBe(0);
    expect(itemOf(r, pending.message)?.mismatches).toContain('date');
  });

  it('a reversal of a standing payer journal dated after today: accepted -> payer_timing, 0, payer_state standing', async () => {
    const m = await ePay(pool, conn, 500);
    await accepted(m);
    await reverseOn(pool, m.journal, await dayOf(pool, 3));
    const r = await rows();
    healthy(r.summary);
    expect(itemOf(r, m.message)).toMatchObject({ bucket: 'payer_timing', contribution: 0, payerState: 'standing' });
    expect(r.summary.unexplained?.total).toBe(0);
  });

  it("a receipt dated after today: timing; the receipt is outside the partner's balance at T", async () => {
    const m = await fixturePaid(pool, conn, 600, { leg: acct.bLoan });
    const ar = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'receivable' AND is_system_account", [co.A])).rows[0].id as string;
    const je = await plantJournal(pool, co.A, await dayOf(pool, 4), [[acct.aLoan, 600, 0], [ar, 0, 600]], 'P5 future receipt');
    const receipt = (await pool.query(
      `INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, status, gl_journal_entry_id, created_by)
       VALUES ($1, $2, CURRENT_DATE + 4, 600, 'contra', 'confirmed', $3, $4) RETURNING id`, [co.A, party.aCustomer, je, U.ab])).rows[0].id as string;
    await forgeMessage(pool, m.message, "status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2, handled_at = now()", [receipt]);
    const r = await rows();
    healthy(r.summary);
    expect(itemOf(r, m.message)).toMatchObject({ bucket: 'timing', receiverState: 'clearing_dated_after', contribution: -600 });
    expect(r.summary.partner).toMatchObject({ balance: 0, attributed: 0 });
    expect(r.summary.unexplained?.total).toBe(0);
  });
});

describe('unapply, then re-apply on the same journal ((k).6)', () => {
  it('m1 not_live, m2 in_flight, payer_journal_differs false, U = 0, Reconciles', async () => {
    const m1 = await fixturePaid(pool, conn, 400, { leg: acct.bLoan });
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [m1.allocation]);
    const m2 = await reapply(pool, m1.payment, m1.bill, 400);
    const r = await rows();
    healthy(r.summary);
    expect(itemOf(r, m1.message)).toMatchObject({ bucket: 'not_live', payerState: 'allocation_gone', contribution: 0 });
    expect(itemOf(r, m2.message)).toMatchObject({ bucket: 'in_flight', payerJournalDiffers: false, contribution: -400 });
    expect(r.summary).toMatchObject({ difference: -400, reconciles: true });
    expect(r.summary.own).toMatchObject({ balance: -400, attributed: -400, other: 0 });
    expect(r.summary.unexplained?.total).toBe(0);
  });
});

describe('a loan account changed after the clearing ((k).8)', () => {
  it("B's side re-pointed: the accepted message is loan_account_changed, figures cover the current account only, no Reconciles", async () => {
    const m = await ePay(pool, conn, 700);
    await accepted(m);
    const old = acct.bLoan;
    await freshLoans(pool);
    // A keeps its account: put it back; B's side now names the new one
    acct.aLoan = (await pool.query('SELECT loan_account_id FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [conn, co.A])).rows[0].loan_account_id;
    await forgeSide(pool, conn, co.B, 'loan_account_id = $3', [acct.bLoan]);
    expect(acct.bLoan).not.toBe(old);
    const r = await rows();
    healthy(r.summary);
    expect(itemOf(r, m.message)).toMatchObject({ bucket: 'loan_account_changed', contribution: 700 });
    expect(r.summary).toMatchObject({ loanAccountChanged: true, reconciles: false });
    expect(r.summary.own).toMatchObject({ balance: 0, attributed: 0 });
    expect(r.summary.unexplained?.total).toBe(0);
  });
});

describe('a migration_admin-forged withdrawal ((k).7)', () => {
  it('source_cancelled_at on an allocation message: withdrawn, listed under Needs attention, no Reconciles', async () => {
    const m = await fixturePaid(pool, conn, 250, { leg: acct.bLoan });
    await forgeMessage(pool, m.message, 'source_cancelled_at = now()');
    const r = await rows();
    healthy(r.summary);
    expect(itemOf(r, m.message)).toMatchObject({ bucket: 'withdrawn', contribution: -250 });
    expect(r.summary.reconciles).toBe(false);
    const att = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention' }));
    expect(att.section.items.map((i) => i.id)).toContain(m.message);
  });
});

describe('Needs attention', () => {
  it("unsent: S's processed payments on linked bills with no message, S's own facts only; never in the partner's report", async () => {
    const a = await fixturePaid(pool, conn, 410, { leg: acct.bLoan, send: false });
    const b = await fixturePaid(pool, conn, 420, { send: false });
    const att = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention' }));
    const unsent = att.section.items.filter((i) => i.kind === 'unsent');
    expect(unsent.map((i) => i.id).sort()).toEqual([a.allocation, b.allocation].sort());
    const row = unsent.find((i) => i.id === a.allocation)!;
    expect(row).toMatchObject({ amount: 410, flags: ['unsent'], bucket: null, cutover: '2026-01-01', own: { billId: a.bill, paymentId: a.payment, paymentStatus: 'processed' } });
    expect(row.own.billNumber).toMatch(/^P5B-/);
    expect(row.display.paymentDate).toBe('2026-09-01');
    const theirs = reportOf(await reportAs(U.a, co.A, conn, { section: 'attention' }));
    expect(theirs.section.items.filter((i) => i.kind === 'unsent')).toEqual([]);
    // the summary's figures are untouched by the unsent rows (no message, no bucket)
    expect(att.summary.components?.reduce((n, c) => n + c.count, 0)).toBe(0);
  });

  it('unlinked_partner_bill: a paid bill of the side supplier on or after the cut-over with no live link; not one before it', async () => {
    const lone = await pair(pool, conn, 330, { link: false, paid: 330 });
    const unlinked = await pair(pool, conn, 340, { link: false, paid: 100 });
    await linkBill(pool, conn, unlinked.invoice, unlinked.bill, 'unlinked');
    await pair(pool, conn, 350, { link: false, paid: 350, date: '2025-12-01' });
    await pair(pool, conn, 360, { link: false, paid: 0 });
    const att = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention' }));
    const bills = att.section.items.filter((i) => i.kind === 'unlinked_bill');
    expect(bills.map((i) => i.id).sort()).toEqual([lone.bill, unlinked.bill].sort());
    expect(bills.every((i) => i.flags.includes('unlinked_partner_bill'))).toBe(true);
  });

  it('pending_too_long after 7 days (not at 6), failed with its stored sentence', async () => {
    const old = await fixturePaid(pool, conn, 210, { leg: acct.bLoan });
    const young = await fixturePaid(pool, conn, 220, { leg: acct.bLoan });
    const failed = await fixturePaid(pool, conn, 230, { leg: acct.bLoan });
    await forgeMessage(pool, old.message, "created_at = now() - interval '8 days'");
    await forgeMessage(pool, young.message, "created_at = now() - interval '6 days'");
    await forgeMessage(pool, failed.message, "status = 'failed', error = 'The partner could not clear this payment.'");
    const r = await rows();
    healthy(r.summary);
    expect(itemOf(r, old.message)?.flags).toContain('pending_too_long');
    expect(itemOf(r, young.message)?.flags).not.toContain('pending_too_long');
    expect(itemOf(r, failed.message)).toMatchObject({ bucket: 'in_flight', flags: ['failed'], error: 'The partner could not clear this payment.' });
    const att = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention', limit: '2', offset: '0' }));
    expect(att.section.total).toBe(2);
    expect(att.section.items.map((i) => i.id)).toEqual([old.message, failed.message]);
  });
});

describe('pagination ((k).11)', () => {
  it('pages cut the list only: total and the whole summary on every page, each with its own readAt, ORDER BY created_at, id', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await fixturePaid(pool, conn, 100 + i)).message);
    const p1 = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention', limit: '2', offset: '0' }));
    const p3 = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention', limit: '2', offset: '4' }));
    expect(p1.section).toMatchObject({ total: 5, limit: 2, offset: 0 });
    expect(p1.section.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(p3.section.items.map((i) => i.id)).toEqual(ids.slice(4));
    expect(p3.summary).toEqual(p1.summary);
    expect(Date.parse(p3.readAt)).toBeGreaterThanOrEqual(Date.parse(p1.readAt));
  });
});
