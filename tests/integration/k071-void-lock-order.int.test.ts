/**
 * K-071 round-9 HIGH — the THIRD lock-order inversion, on real SQL.
 *
 * `voidSupplierPayment` took `gl_journal_entries` (its `FOR UPDATE` on the
 * payment's posted entry) → `supplier_invoices` (the un-apply loop) →
 * `supplier_payments` (the status flip): the exact inverse of the canonical
 * order every other settlement path takes, and of `voidPaymentDocument`, which
 * reaches the SAME supplier payment through `unwindOnePayment` after locking
 * payment then invoices then GL. Two agents undoing one payment from its two
 * entrances therefore held a row each.
 *
 * The previous two rounds argued that a given pair "could not form a cycle".
 * That argument has been wrong three times, so this file does not make it: the
 * peer takes the rows in the canonical order and the OUTCOME decides.
 *
 * MEASURED, both directions. With the void ordered correctly the peer's second
 * and third locks are free and the void settles 200. With the old order
 * restored (journal `FOR UPDATE` first, no payment lock) Postgres reports
 * `40P01 deadlock detected` and the VOID is the victim — the route answers
 * 400 "deadlock detected", the money path telling a user their undo failed
 * because somebody else arrived at the same instant.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedBill, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
/**
 * A name unique to THIS test process, stamped on every connection this pool
 * hands out, so the readiness probe below can tell its own backends apart from
 * the other branches sharing this fixture database.
 */
const APP_NAME = `k071-void-lock-order-${process.pid}`;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: APP_NAME,
});
let fx: K074Fixture;

beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => {
  try { await cleanupK074(pool, fx); } finally { await pool.end(); }
});

const wait = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/** Drive `supplier-payments-action` under an als-bound request transaction. */
async function paymentAction(
  action: 'process' | 'void', paymentId: string,
): Promise<{ status: number; body: unknown }> {
  const { als } = await import('@/lib/als');
  const handler = (await import('../../pages/api/accounting/supplier-payments-action')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;

  const result = response();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      const req = {
        method: 'POST', body: { action, paymentId },
        companyId: fx.company, user: { id: fx.user },
      } as unknown as NextApiRequest;
      await handler(req, result.res);
    });
    if (result.state.statusCode < 500) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  return { status: result.state.statusCode, body: result.state.body };
}

/** A PROCESSED supplier payment settling `bill` — posted journal and all. */
async function seedProcessedPayment(bill: string, amount: number): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,
       payment_method,status,created_by,bank_account_id)
     VALUES($1,$2,$3,$4,$5,'eft','approved',$6,$7)`,
    [id, fx.company, fx.supplier, DAY, amount, fx.user, fx.bankAccount],
  );
  await pool.query(
    // No company_id on this table — tenancy is inherited through payment_id.
    `INSERT INTO payment_allocations(id,payment_id,invoice_id,amount_allocated)
     VALUES($1,$2,$3,$4)`,
    [crypto.randomUUID(), id, bill, amount],
  );
  const processed = await paymentAction('process', id);
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);
  return id;
}

/**
 * Block until the void is PARKED on the payment row the peer holds.
 *
 * A fixed sleep would let the peer reach for the journal before the void has
 * taken anything, and the test would pass on the defect. Matched on the
 * statement text of `lockSupplierPaymentForUpdate` AND scoped to this process's
 * own backends (`application_name = APP_NAME`): the text alone matches any
 * session in the cluster blocked on that statement, and this fixture database
 * is shared with the other branches — one of theirs returning the probe early
 * is a false GREEN, not a flake.
 */
async function waitForVoidParkedOnPayment(): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND datname = current_database()
         AND application_name = $1
         AND pid <> pg_backend_pid()
         AND query ILIKE '%FROM supplier_payments%'
         AND query ILIKE '%FOR UPDATE OF sp%'`,
      [APP_NAME],
    );
    if (rows[0].n > 0) return;
    await wait(50);
  }
  throw new Error('the void never blocked on the payment row — the race did not set up');
}

it('a peer holding the payment then taking the bill and the journal does not deadlock', async () => {
  const bill = await seedBill(pool, fx, 1000);
  const payment = await seedProcessedPayment(bill, 400);
  const { rows: je } = await pool.query(
    'SELECT gl_journal_entry_id FROM supplier_payments WHERE id=$1', [payment],
  );
  const journal = je[0].gl_journal_entry_id as string;
  expect(journal, 'the processed payment must carry a posted journal').toBeTruthy();

  const peer = await pool.connect();
  let peerError: string | null = null;
  let voided: { status: number; body: unknown };
  try {
    await peer.query('BEGIN');
    // Below the void's own 5s lock_timeout, so a genuine 40P01 is what fails
    // this test rather than a timeout standing in for one.
    await peer.query("SET LOCAL lock_timeout = '4s'");
    // (2) the payment — the canonical first row for a path with no bank line.
    await peer.query('SELECT id FROM supplier_payments WHERE id=$1 FOR UPDATE', [payment]);

    const voiding = paymentAction('void', payment);
    await waitForVoidParkedOnPayment();

    try {
      // (3) then the bill and (4) then the journal, in canonical order. Under
      // the OLD order the void already holds the journal while waiting for the
      // bill, and one of the two is killed with 40P01.
      await peer.query('SELECT id FROM supplier_invoices WHERE id=$1 FOR UPDATE', [bill]);
      await peer.query('SELECT id FROM gl_journal_entries WHERE id=$1 FOR UPDATE', [journal]);
    } catch (err) {
      peerError = (err as { code?: string }).code ?? (err as Error).message;
    }
    await peer.query('ROLLBACK');
    voided = await voiding;
  } finally {
    peer.release();
  }

  expect(peerError).toBeNull();
  expect(voided.status, JSON.stringify(voided.body)).toBe(200);

  // And the void actually did its work once the peer let go.
  const { rows: after } = await pool.query(
    'SELECT status FROM supplier_payments WHERE id=$1', [payment],
  );
  expect(after[0].status).toBe('cancelled');
  const { rows: billRow } = await pool.query(
    'SELECT amount_paid FROM supplier_invoices WHERE id=$1', [bill],
  );
  expect(Number(billRow[0].amount_paid)).toBe(0);
}, 40000);

it('a payment held past the 5s budget is a refusal that wrote nothing', async () => {
  const bill = await seedBill(pool, fx, 1000);
  const payment = await seedProcessedPayment(bill, 400);

  const holder = await pool.connect();
  let result: { status: number; body: unknown };
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM supplier_payments WHERE id=$1 FOR UPDATE', [payment]);
    result = await paymentAction('void', payment);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  expect(JSON.stringify(result.body)).toMatch(/retry in a moment/i);
  expect(result.status).toBeLessThan(500);

  // Pre-write: the lock is the void's first act, so nothing moved.
  const { rows } = await pool.query('SELECT status FROM supplier_payments WHERE id=$1', [payment]);
  expect(rows[0].status).toBe('processed');
  const { rows: billRow } = await pool.query(
    'SELECT amount_paid FROM supplier_invoices WHERE id=$1', [bill],
  );
  expect(Number(billRow[0].amount_paid)).toBe(400);
}, 40000);
