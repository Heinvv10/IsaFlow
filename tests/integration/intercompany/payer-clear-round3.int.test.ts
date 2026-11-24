/**
 * Intercompany P4-E, fix round 3 (MED, a regression of round 2's LOW-1). The reversal claim took the payer's journal advisory key for EVERY
 * journal of a company that ever sent an allocation message, so a flow that holds the journal row first (an invoice cancel) and then reverses
 * it could deadlock with a GL reversal of the same journal (key, then row): 40P01. Now the key is taken only for a journal chain an allocation
 * message stands on, and the flows that can hold such a journal's row first (the batch reversal and every other `lockJournalAndUnmatch`
 * caller, and every `lockChainHead` caller: the bank reallocation, the provisional void) take the key BEFORE the row. LOW-1: a key wait that
 * runs out says what holds it, not "another reversal".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import journalActionRoute from '../../../pages/api/accounting/journal-entries-action';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { reverseBatch } from '../../../src/modules/accounting/services/ap/batchPaymentReversal';
import { lockStandingChainHead } from '../../../src/modules/accounting/services/shared/journalChainHead';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { co, party, tokens, U, wipeConnections } from './intercompany.helpers';
import { acc, asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments, plantBatchRow, plantPaid, plantPaymentJournal, sendFor } from './allocation.helpers';
import { holdCapLock } from './allocation-clear-round1.helpers';
import { lockWaiter } from './ledger.helpers';
import { clearBill, clearBody, clearConnect, clearedOf, errorText, payerSetup, plantBill } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => {
  await pool.query('DELETE FROM customer_invoices WHERE company_id = $1 AND invoice_number LIKE $2', [co.B, 'ICR3-%']);
  await clearPayments(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

const reverseViaGl = (journal: string) => callRoute(journalActionRoute, tokens[U.b]!, co.B, 'POST', { action: 'reverse', id: journal },
  '/api/accounting/journal-entries-action');

/** A session holding the payer's journal key of `journal` (1027's cap-lock key, as a receiver's clearing takes it) until `release`. */
async function holdJournalKey(journal: string): Promise<{ release: () => Promise<void> }> {
  const client: PoolClient = await pool.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT || ':journal:' || $2::TEXT, 1027))", [co.B, journal]);
  return { release: async () => { await client.query('COMMIT'); client.release(); } };
}

const advisoryWaiters = async () => Number((await pool.query(
  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'")).rows[0].n);

/** Wait until `done()` or `n` sessions wait on an advisory lock (whichever first), at most 10 s. */
async function untilSettledOrWaiting(done: () => boolean, n: number): Promise<void> {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (done() || await advisoryWaiters() >= n) return;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  throw new Error(`neither settled nor ${n} advisory waiter(s) within 10 s`);
}

/** Is the row free right now (another session can lock it without waiting)? */
async function rowFree(id: string): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await c.query('SELECT 1 FROM gl_journal_entries WHERE id = $1 FOR UPDATE NOWAIT', [id]).then(() => true, (e: { code?: string }) => {
      if (e.code === '55P03') return false;
      throw e;
    });
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const contras = async (journal: string) => Number((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [journal])).rows[0].n);
type Outcome = { ok: true } | { ok: false; code: string | undefined; message: string };
const outcomeOf = (p: Promise<unknown>): Promise<Outcome> => p.then(() => ({ ok: true as const }),
  (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code, message: String(e.message) }));

/** A posted, approved customer invoice of B (the payer) with its own journal: no allocation message stands on it. */
async function plantPayerInvoice(): Promise<{ invoice: string; journal: string }> {
  const invoice = crypto.randomUUID();
  const journal = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
     VALUES (DATE '2026-09-01', 'Customer invoice (planted)', 'auto_invoice', 'draft', $1, $2) RETURNING id`, [U.ab, co.B])).rows[0].id as string;
  // two of B's own accounts (the payer's chart in this fixture has no receivable): only the journal's company and chain matter here
  for (const [account, debit, credit] of [[acc.bExp2, 115, 0], [acc.bExp1, 0, 115]] as const) {
    await pool.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [journal, account, debit, credit, co.B, 'planted']);
  }
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [journal]);
  await pool.query(
    `INSERT INTO customer_invoices(id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
       total_amount, currency_code, exchange_rate, status, created_by, gl_journal_entry_id)
     VALUES ($1, $2, $3, $4, $4, DATE '2026-09-01', DATE '2026-10-01', 100, 15, 15, 115, 'ZAR', 1, 'approved', $5, $6)`,
    [invoice, co.B, `ICR3-${invoice.slice(0, 8)}`, party.bCustomer, U.ab, journal]);
  return { invoice, journal };
}

describe('MED: a journal no allocation message stands on takes no payer key', () => {
  it('a GL reversal and an invoice cancel of the same invoice journal, for a payer that sent allocation messages: no deadlock, one contra', async () => {
    clearedOf(await clearBill(clearBody(await plantBill(pool, conn)))); // B has sent an allocation message
    const { invoice, journal } = await plantPayerInvoice();
    const held = await holdJournalKey(journal);
    let glDone = false;
    let cancelDone = false;
    const gl = reverseViaGl(journal).finally(() => { glDone = true; });
    let cancel: Promise<Outcome> = Promise.resolve({ ok: true });
    try {
      await untilSettledOrWaiting(() => glDone, 1);
      cancel = outcomeOf(asService(pool, U.b, co.B, () => cancelCustomerInvoice(co.B, invoice, U.b, { allowReversal: true })))
        .finally(() => { cancelDone = true; });
      await untilSettledOrWaiting(() => cancelDone, 2);
    } finally {
      await held.release();
    }
    const [glRes, cancelled] = [await gl, await cancel];
    expect(errorText(glRes)).not.toMatch(/deadlock/i);
    expect(glRes.state.statusCode).toBeLessThan(500);
    if (!cancelled.ok) {
      expect(cancelled.code).not.toBe('40P01');
      expect(cancelled.message).toMatch(/already reversed/i);
    }
    expect(await contras(journal)).toBe(1);
  }, 30000);
});

describe('MED: the batch reversal takes the payer key before the batch journal row', () => {
  it('a GL reversal and a batch reversal of a batch journal an allocation message stands on: no deadlock, at most one contra', async () => {
    const b = await plantBill(pool, conn);
    await pool.query("UPDATE supplier_invoices SET amount_paid = 1150, status = 'paid' WHERE id = $1", [b.bill]);
    const journal = await plantPaymentJournal(pool, 1150);
    const batch = await plantBatchRow(pool, { journal });
    const member = await plantPaid(pool, b.bill, { batch });
    expect((await sendFor(pool, member.allocation)).reason).toBeNull();
    const held = await holdJournalKey(journal);
    let glDone = false;
    let batchDone = false;
    const gl = reverseViaGl(journal).finally(() => { glDone = true; });
    let reversed: Promise<Outcome> = Promise.resolve({ ok: true });
    try {
      await untilSettledOrWaiting(() => glDone, 1);
      reversed = outcomeOf(asService(pool, U.b, co.B, () => reverseBatch(co.B, batch, U.b))).finally(() => { batchDone = true; });
      await untilSettledOrWaiting(() => batchDone, 2);
    } finally {
      await held.release();
    }
    const [glRes, batchOut] = [await gl, await reversed];
    expect(errorText(glRes)).not.toMatch(/deadlock/i);
    expect(glRes.state.statusCode).toBeLessThan(500);
    if (!batchOut.ok) expect(batchOut.code).not.toBe('40P01');
    expect(await contras(journal)).toBeLessThanOrEqual(1);
  }, 30000);
});

describe('MED: lockChainHead takes the payer key before the head row', () => {
  it("while a receiver's clearing holds the key, locking the clearing journal's chain head waits on the key with the row still free", async () => {
    const out = clearedOf(await clearBill(clearBody(await plantBill(pool, conn))));
    const held = await holdCapLock(pool, out.messageId);
    let settled = false;
    const locking = asService(pool, U.b, co.B, () => lockStandingChainHead(co.B, out.journalEntryId)).finally(() => { settled = true; });
    try {
      expect(await lockWaiter(pool, 'advisory')).toBe(true);
      expect(settled).toBe(false);
      expect(await rowFree(out.journalEntryId)).toBe(true);
    } finally {
      await held.release();
    }
    expect(await locking).toBe(out.journalEntryId);
  }, 30000);
});

describe('LOW-1: a payer key wait that runs out says what holds it', () => {
  it('a GL reversal of the clearing journal while the key is held past the 5 s bound: 503, naming the intercompany payment, not another reversal', async () => {
    const out = clearedOf(await clearBill(clearBody(await plantBill(pool, conn))));
    const held = await holdCapLock(pool, out.messageId);
    try {
      const res = await reverseViaGl(out.journalEntryId);
      expect(res.state.statusCode).toBe(503);
      expect(errorText(res)).toMatch(/intercompany payment/);
      expect(errorText(res)).not.toMatch(/is being reversed by another request/);
    } finally {
      await held.release();
    }
    expect(await contras(out.journalEntryId)).toBe(0);
  }, 30000);
});
