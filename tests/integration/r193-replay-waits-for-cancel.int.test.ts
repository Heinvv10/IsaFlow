/**
 * R-193: a charge.success replay and a cancel of the same gateway receipt, in the same instant.
 *
 * The replay's dedupe read (`gatewaySettledReceipt.findSettledReceipt`) used to be a plain read. A
 * replay could read the receipt LIVE while a person's `cancelCustomerPayment` of it was in flight;
 * the cancel committed, and the replay went on down the live second-report path and posted the fee
 * leg against the now-cancelled receipt with no review reason. The read now locks the receipts it
 * matches (`FOR UPDATE OF cp`, under the 5 s row-lock budget), so:
 *   - a cancel that holds the receipt first makes the replay WAIT; the replay then reads it
 *     cancelled: no fee, flagged `already_settled_cancelled_receipt` (the R-187 outcome);
 *   - a replay that holds it first makes the cancel wait; the fee posts against a live receipt and
 *     the cancel follows it (cancel keeps the fee by design): no flag, no deadlock;
 *   - a wait longer than the budget fails the delivery (500, rolled back), and Paystack's
 *     redelivery of the same body is processed (K-035).
 *
 * The window is opened with the sql-wrapper pattern (r129): the replay's dedupe read is matched on
 * its table and predicate, not its exact text, and every test asserts the hook fired. Real
 * Postgres (isaflow-fixture-r19x), the real webhook route and the real cancel service.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, pool, seed, settlement, verify } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { feeJournals } from './r187-books.helpers';

assertDisposable();

type Read = Promise<unknown>;
const hooks = vi.hoisted(() => ({
  /** Runs once, around the replay's dedupe read: `before` it, then `during` it with the read in flight. */
  race: null as null | { before: () => Promise<void>; during: (read: Read) => Promise<void>; fired: boolean },
}));

const paystack = vi.hoisted(() => ({ verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => paystack.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>;
  // The dedupe read: receipts for a reference, admitting a cancelled one only on the gateway's journal stamp.
  const isDedupeRead = (text: string) => /^\s*SELECT/.test(text) && text.includes('FROM customer_payments cp')
    && text.includes('cp.bank_reference =') && text.includes('posting_agent');
  // Every other statement gets the real lazy query back untouched (`sql.transaction` reads its text), and
  // Object.assign keeps the real tag's own members (`transaction`, `unsafe`, `query`).
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const race = hooks.race;
    if (!race || !isDedupeRead(strings.join('?'))) return realSql(strings, ...values);
    hooks.race = null;
    race.fired = true;
    return (async () => {
      await race.before();
      const read = Promise.resolve(realSql(strings, ...values));
      await race.during(read.catch(() => undefined));
      return read;
    })();
  }, realSql);
  return { ...real, sql };
});

const FLAG = 'review:already_settled_cancelled_receipt';
const replayBody = () => ({ id: Math.floor(Math.random() * 1e9), fees: 350 });

/** Resolves true once a backend in this database waits on a lock while running `like`; false after `ms`. */
async function lockWaitSeen(like: string, ms = 4000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [like]);
    if (rows[0]!.n > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** The reference's one confirmed receipt. */
async function receiptOf(ref: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM customer_payments WHERE company_id = $1 AND bank_reference = $2 AND status = 'confirmed'", [A.id, ref]);
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** A cancel through the receipts page's service on its own connection, left OPEN: commit() ends it. */
async function openCancel(receiptId: string): Promise<{ commit: () => Promise<void> }> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    await als.run({ client: c, userId: A.user, companyId: A.id, claims: {} } as never,
      () => cancelCustomerPayment(A.id, receiptId, A.user, 'r193 race'));
  } catch (err) {
    await c.query('ROLLBACK');
    c.release();
    throw err;
  }
  return { commit: async () => { try { await c.query('COMMIT'); } finally { c.release(); } } };
}

/** A banked gateway receipt with no fee leg yet: the replay that carries `fees` would post one. */
async function bankedReceipt(): Promise<{ id: string; ref: string; receipt: string }> {
  const id = await invoice(A);
  const ref = await checkout(A, id);
  expect((await deliver(ref, 11500)).statusCode).toBe(200);
  expect(await feeJournals(ref)).toBe(0);
  return { id, ref, receipt: await receiptOf(ref) };
}

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  clearSystemAccountCache();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanup([A]);
});

describe('R-193: the replay\'s dedupe read locks the receipt it matches', () => {
  it('a cancel holding the receipt commits while the replay waits: the replay reads it cancelled, posts no fee, flags', async () => {
    const { id, ref, receipt } = await bankedReceipt();
    let cancel: { commit: () => Promise<void> } | null = null;
    let committedWhen: 'replay blocked' | 'replay read returned' | null = null;
    const race = {
      fired: false,
      before: async () => { cancel = await openCancel(receipt); },
      during: async (read: Read) => {
        committedWhen = await Promise.race([
          read.then(() => 'replay read returned' as const),
          lockWaitSeen('%FROM customer_payments cp%').then((seen) => (seen ? 'replay blocked' as const : new Promise<never>(() => {}))),
        ]);
        await cancel!.commit();
      },
    };
    hooks.race = race;

    expect((await deliver(ref, 11500, 'ZAR', replayBody())).statusCode).toBe(200);

    expect(race.fired).toBe(true);
    expect({ feeJournals: await feeJournals(ref), ...(await settlement(A, ref, id)) }).toMatchObject(
      { feeJournals: 0, payments: [{ status: 'cancelled' }], review: FLAG });
    // The cancel committed while the replay's read was WAITING on it, not after the read returned.
    expect(committedWhen).toBe('replay blocked');
  }, 30_000);

  it('a replay holding the receipt makes the cancel wait: the fee posts against the live receipt, then the cancel, no deadlock', async () => {
    const { id, ref, receipt } = await bankedReceipt();
    let cancelDone: Promise<void> | null = null;
    let cancelWaited = false;
    const race = {
      fired: false,
      before: async () => undefined,
      during: async (read: Read) => {
        await read;
        cancelDone = openCancel(receipt).then((c) => c.commit());
        cancelWaited = await lockWaitSeen('%customer_payments%', 2000);
      },
    };
    hooks.race = race;

    expect((await deliver(ref, 11500, 'ZAR', replayBody())).statusCode).toBe(200);
    await cancelDone;

    expect(race.fired).toBe(true);
    expect(cancelWaited).toBe(true);
    expect(await feeJournals(ref)).toBe(1);
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ status: 'cancelled' }], review: null });
  }, 30_000);

  it('a lock held past the budget fails the delivery (500, nothing written); the redelivery is processed', async () => {
    const { ref, receipt } = await bankedReceipt();
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM customer_payments WHERE id = $1 FOR UPDATE', [receipt]);
    const released = new Promise<void>((resolve) => {
      setTimeout(() => { void holder.query('COMMIT').finally(() => { holder.release(); resolve(); }); }, 9000);
    });
    const body = replayBody();

    const started = Date.now();
    const first = await deliver(ref, 11500, 'ZAR', body);
    const waited = Date.now() - started;
    await released;

    expect(first.statusCode).toBe(500);
    expect(waited).toBeGreaterThan(4000);
    expect(waited).toBeLessThan(8500);
    expect(await feeJournals(ref)).toBe(0);
    // The same body again, as Paystack redelivers it: processed, not acked as a duplicate.
    expect((await deliver(ref, 11500, 'ZAR', body)).statusCode).toBe(200);
    expect(await feeJournals(ref)).toBe(1);
  }, 30_000);

  it('verify behind a receipt held past the budget answers pending (never failed), rolls back, posts no fee (review L2)', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    // A receipt already carrying the reference (a draft a person keyed), held by another transaction.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customer_payments (company_id, client_id, payment_date, total_amount, payment_method,
         bank_reference, created_by, status)
       VALUES ($1, $2, CURRENT_DATE, 115, 'eft', $3, $4, 'draft') RETURNING id`, [A.id, A.customer, ref, A.user]);
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM customer_payments WHERE id = $1 FOR UPDATE', [rows[0]!.id]);
    paystack.verifyTransaction.mockResolvedValue(
      { status: 'success', id: 1931, amountCents: 11500, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card', feesCents: 350 });

    // Released after 12 s whatever happens, so an unbounded wait answers late instead of hanging.
    const released = new Promise<void>((resolve) => {
      setTimeout(() => { void holder.query('COMMIT').finally(() => { holder.release(); resolve(); }); }, 12_000);
    });

    const started = Date.now();
    const answer = await verify(ref);
    const waited = Date.now() - started;
    await released;

    expect(answer.body.data).toMatchObject({ status: 'pending' });
    expect(waited).toBeGreaterThan(4000);
    expect(waited).toBeLessThan(8500);
    expect(await feeJournals(ref)).toBe(0);
    const { rows: pr } = await pool.query<{ status: string }>(
      'SELECT status FROM paystack_payment_requests WHERE paystack_reference = $1', [ref]);
    expect(pr[0]!.status).toBe('pending');
  }, 30_000);
});
