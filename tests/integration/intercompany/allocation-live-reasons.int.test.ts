/**
 * Intercompany P4-C: is an allocation message still TRUE? (`intercompany_allocation_message_live`, migration 1026). The RECEIVER (A, the issuer)
 * asks; the definer checks the RELATIONSHIP first (the connection active and loan, the payload's link active between the payer's bill and the
 * receiver's invoice, the payment on or after the cut-over), before it reads any payer row, then re-reads the payer's rows the message was built
 * from, and answers `(true, 'ok')` or the first thing that is no longer so: not_pending, link_gone, before_cutover, allocation_gone, changed,
 * payment_not_posted, journal_reversed, bill_gone. It writes nothing: no message, no document, no journal changes around the call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { enableFxDocuments } from '../r035-approval.helpers';
import { asAppUser, count, withoutTrigger } from './intercompany.helpers';
import { co, mirrorCleanup, rawReverseJournal, U, wipeConnections } from './mirror.helpers';
import { allocSetup, clearPayments, loanConnect, plantBatchRow, plantBill, plantPaid, plantPaymentJournal, sendFor } from './allocation.helpers';
import { liveFor, sentAllocation } from './allocation-live.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => allocSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await loanConnect(pool);
});

const asA = (text: string, params: unknown[], user = U.a) => asAppUser(pool, user, co.A, (q) => q.query(text, params), true);
// the pair's agreement changes with a write role in BOTH companies (the connections guard)
const onConnection = (set: string) => asA(`UPDATE intercompany_connections SET ${set} WHERE id = $1`, [conn], U.ab);
const unlink = (link: string) => withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard',
  (q) => q.query("UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link]));

describe('a message that is still what the payer\'s books say', () => {
  it('answers (true, ok) to the receiver; a viewer of the receiver reads it too (a read, not a write role)', async () => {
    const { message } = await sentAllocation(pool, conn);
    expect(await liveFor(pool, message)).toEqual({ live: true, reason: 'ok' });
    expect(await liveFor(pool, message, U.va)).toEqual({ live: true, reason: 'ok' });
  });

  it('a batch member stands on the batch\'s journal: ok while it stands, journal_reversed once it is reversed', async () => {
    const journal = await plantPaymentJournal(pool, 1150);
    const batch = await plantBatchRow(pool, { journal });
    const { message } = await sentAllocation(pool, conn, { batch });
    expect(await liveFor(pool, message)).toEqual({ live: true, reason: 'ok' });
    await rawReverseJournal(pool, journal);
    expect(await liveFor(pool, message)).toEqual({ live: false, reason: 'journal_reversed' });
  });

  it('payload text is compared as the sender cleaned it: a reference re-saved with outer whitespace is still ok, a new reference is changed', async () => {
    const { message, payment } = await sentAllocation(pool, conn);
    await pool.query("UPDATE supplier_payments SET reference = '  IC alloc ref \t' WHERE id = $1", [payment]);
    expect(await liveFor(pool, message)).toEqual({ live: true, reason: 'ok' });
    await pool.query("UPDATE supplier_payments SET reference = 'IC alloc ref 2' WHERE id = $1", [payment]);
    expect(await liveFor(pool, message)).toEqual({ live: false, reason: 'changed' });
  });

  it('a failed message is still judged (it is not handled yet)', async () => {
    const { message } = await sentAllocation(pool, conn);
    await asA("UPDATE intercompany_messages SET status = 'failed', error = 'x' WHERE id = $1", [message]);
    expect(await liveFor(pool, message)).toEqual({ live: true, reason: 'ok' });
  });
});

describe('each way a message goes stale answers its reason', () => {
  type Sent = Awaited<ReturnType<typeof sentAllocation>>;
  const cases: Array<[string, string, (s: Sent) => Promise<unknown>]> = [
    ['rejected by the receiver', 'not_pending', (s) => asA("UPDATE intercompany_messages SET status = 'rejected', reason = 'no' WHERE id = $1", [s.message])],
    ['dismissed by the receiver', 'not_pending', (s) => asA("UPDATE intercompany_messages SET status = 'dismissed' WHERE id = $1", [s.message])],
    ['accepted (planted: since 1027 the guard refuses a direct UPDATE without the clearing)', 'not_pending', (s) => withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard',
      (q) => q.query("UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [s.message]))],
    ['withdrawn (planted: no path withdraws an allocation yet)', 'not_pending', (s) => withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard',
      (q) => q.query("UPDATE intercompany_messages SET status = 'withdrawn', source_cancelled_at = now() WHERE id = $1", [s.message]))],
    ['the payment renumbered', 'changed', (s) => pool.query("UPDATE supplier_payments SET payment_number = 'SP-RENUMBERED' WHERE id = $1", [s.payment])],
    ['the payment method changed', 'changed', (s) => pool.query("UPDATE supplier_payments SET payment_method = 'cheque' WHERE id = $1", [s.payment])],
    ['the bill\'s currency changed', 'changed', async (s) => {
      await enableFxDocuments(pool, co.B);
      await pool.query("UPDATE supplier_invoices SET currency_code = 'USD', currency = 'USD' WHERE id = $1", [s.bill]);
    }],
    ['the allocation row deleted (unapplied)', 'allocation_gone', (s) => pool.query('DELETE FROM payment_allocations WHERE id = $1', [s.allocation])],
    ['the allocated amount changed', 'changed', (s) => pool.query('UPDATE payment_allocations SET amount_allocated = 1000 WHERE id = $1', [s.allocation])],
    ['the allocation moved to another bill', 'changed', async (s) => {
      const other = await plantBill(pool, conn, { link: false });
      await pool.query('UPDATE payment_allocations SET invoice_id = $2 WHERE id = $1', [s.allocation, other.bill]);
    }],
    ['the payment re-dated', 'changed', (s) => pool.query("UPDATE supplier_payments SET payment_date = DATE '2026-09-02' WHERE id = $1", [s.payment])],
    ['the bill renumbered', 'changed', (s) => pool.query("UPDATE supplier_invoices SET invoice_number = 'RENUMBERED-1' WHERE id = $1", [s.bill])],
    ['the payment unprocessed (back to approved)', 'payment_not_posted', (s) => pool.query("UPDATE supplier_payments SET status = 'approved' WHERE id = $1", [s.payment])],
    ['the payment voided (cancelled)', 'payment_not_posted', (s) => pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [s.payment])],
    ['the payment with a NULL status', 'payment_not_posted', (s) => pool.query('UPDATE supplier_payments SET status = NULL WHERE id = $1', [s.payment])],
    ['the payment journal reversed', 'journal_reversed', (s) => rawReverseJournal(pool, s.journal!)],
    ['the payment now standing on another journal', 'journal_reversed', async (s) =>
      pool.query('UPDATE supplier_payments SET gl_journal_entry_id = $2 WHERE id = $1', [s.payment, await plantPaymentJournal(pool, 1150)])],
    ['the payment with no journal now', 'journal_reversed', (s) => pool.query('UPDATE supplier_payments SET gl_journal_entry_id = NULL WHERE id = $1', [s.payment])],
    ['the bill deleted', 'bill_gone', (s) => pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [s.bill])],
    ['the link unlinked', 'link_gone', (s) => unlink(s.link!)],
    ['the connection revoked', 'link_gone', () => onConnection("status = 'revoked'")],
    ['the connection switched to cash', 'link_gone', () => onConnection("settlement_mode = 'cash'")],
    ['the cut-over moved past the payment date', 'before_cutover', () => onConnection("cutover_date = DATE '2026-09-02'")],
    ['the cut-over cleared', 'before_cutover', () => onConnection('cutover_date = NULL')],
  ];
  it.each(cases)('%s: %s', async (_name, reason, stale) => {
    const sent = await sentAllocation(pool, conn);
    expect(await liveFor(pool, sent.message)).toEqual({ live: true, reason: 'ok' });
    await stale(sent);
    expect(await liveFor(pool, sent.message)).toEqual({ live: false, reason });
  });

  it('the first failure wins, in order: a reversed journal of a deleted bill is journal_reversed; a payment on the cut-over day is still ok', async () => {
    const two = await sentAllocation(pool, conn);
    await rawReverseJournal(pool, two.journal!);
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [two.bill]);
    expect(await liveFor(pool, two.message)).toEqual({ live: false, reason: 'journal_reversed' });
    const onDay = await sentAllocation(pool, conn);
    await onConnection("cutover_date = DATE '2026-09-01'");
    expect(await liveFor(pool, onDay.message)).toEqual({ live: true, reason: 'ok' });
  });
});

describe('a dead relationship answers link_gone and nothing more specific (no payer row is read for it)', () => {
  it.each<[string, string]>([['revoked', "status = 'revoked'"], ['switched to cash', "settlement_mode = 'cash'"]])(
    'a connection %s: a deleted allocation, a reversed journal and a deleted bill all answer link_gone', async (_name, set) => {
      const gone = await sentAllocation(pool, conn);
      const reversed = await sentAllocation(pool, conn);
      const deleted = await sentAllocation(pool, conn);
      await pool.query('DELETE FROM payment_allocations WHERE id = $1', [gone.allocation]);
      await rawReverseJournal(pool, reversed.journal!);
      await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [deleted.bill]);
      await onConnection(set);
      for (const m of [gone, reversed, deleted]) expect(await liveFor(pool, m.message)).toEqual({ live: false, reason: 'link_gone' });
    });

  it('an unlinked link hides an unapplied allocation; a cut-over past the payment hides a reversed journal', async () => {
    const one = await sentAllocation(pool, conn);
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [one.allocation]);
    await unlink(one.link!);
    expect(await liveFor(pool, one.message)).toEqual({ live: false, reason: 'link_gone' });
    const two = await sentAllocation(pool, conn);
    await rawReverseJournal(pool, two.journal!);
    await onConnection("cutover_date = DATE '2026-10-01'");
    expect(await liveFor(pool, two.message)).toEqual({ live: false, reason: 'before_cutover' });
  });
});

describe('unapply then re-apply: only the NEW message is live', () => {
  it('the old message answers allocation_gone, the new one (a new allocation row, a new message) ok', async () => {
    const old = await sentAllocation(pool, conn);
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [old.allocation]);
    const again = await plantPaid(pool, old.bill, { payment: old.payment });
    const sent = await sendFor(pool, again.allocation);
    expect(sent.message_id).toBeTruthy();
    expect(sent.message_id).not.toBe(old.message);
    expect(await liveFor(pool, old.message)).toEqual({ live: false, reason: 'allocation_gone' });
    expect(await liveFor(pool, sent.message_id!)).toEqual({ live: true, reason: 'ok' });
  });
});

describe('the definer writes nothing', () => {
  const companies = () => [[co.A, co.B, co.C]];
  const snapshot = async () => ({
    messages: (await pool.query('SELECT * FROM intercompany_messages WHERE from_company_id = ANY($1) OR to_company_id = ANY($1) ORDER BY id', companies())).rows,
    journals: await count(pool, 'SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = ANY($1)', companies()),
    lines: await count(pool, 'SELECT count(*) AS n FROM gl_journal_lines WHERE company_id = ANY($1)', companies()),
    allocations: (await pool.query('SELECT * FROM payment_allocations ORDER BY id')).rows,
    payments: (await pool.query('SELECT id, status, updated_at FROM supplier_payments WHERE company_id = ANY($1) ORDER BY id', companies())).rows,
    bills: (await pool.query('SELECT id, status, amount_paid, updated_at FROM supplier_invoices WHERE company_id = ANY($1) ORDER BY id', companies())).rows,
    invoices: (await pool.query('SELECT id, status, amount_paid, updated_at FROM customer_invoices WHERE company_id = ANY($1) ORDER BY id', companies())).rows,
    links: (await pool.query('SELECT * FROM intercompany_document_links WHERE company_a_id = ANY($1) ORDER BY id', companies())).rows,
    groupRows: await count(pool, 'SELECT count(*) AS n FROM intercompany_transactions WHERE group_id = $1', [co.G]),
  });

  it('row and journal counts, and every row it reads, are the same after a committed call (live, stale and refused alike)', async () => {
    const live = await sentAllocation(pool, conn);
    const stale = await sentAllocation(pool, conn);
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [stale.allocation]);
    const before = await snapshot();
    const call = (user: string, company: string, id: string) => asAppUser(pool, user, company, async (q) =>
      (await q.query('SELECT live, reason FROM public.intercompany_allocation_message_live($1)', [id])).rows, true);
    expect(await call(U.a, co.A, live.message)).toEqual([{ live: true, reason: 'ok' }]);
    expect(await call(U.a, co.A, stale.message)).toEqual([{ live: false, reason: 'allocation_gone' }]);
    expect(await call(U.b, co.B, live.message)).toEqual([{ live: false, reason: 'not_found' }]);
    expect(await snapshot()).toEqual(before);
  });

  it('is declared STABLE, so the database itself refuses any write inside it', async () => {
    const v = (await pool.query("SELECT provolatile FROM pg_proc WHERE oid = 'public.intercompany_allocation_message_live(uuid)'::regprocedure")).rows[0];
    expect(v.provolatile).toBe('s');
  });
});
