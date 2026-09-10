/**
 * K-071 round-7 MEDIUM-1 — the canonical lock order, on real SQL.
 *
 * Both `bank-match-confirm` arms used to take their FIRST row lock on the
 * document (`FOR UPDATE OF ci` / `OF si`, inside `fetchInvoiceCandidates` /
 * `fetchBillCandidates`) and only reach `bank_transactions` afterwards, inside
 * `allocateTransaction`. Every OTHER write path — `allocateTransaction`,
 * `splitAllocateTransaction`, `reverseReconciledTransaction` — takes the bank
 * line first. Two requests naming the same (line, invoice) pair from the two
 * directions therefore held one row each and deadlocked: Postgres kills one
 * with 40P01, which reaches `withAuth` as a 500 — the money path answering
 * "server fault" to a user whose only mistake was arriving at the same instant
 * as somebody else. That is the outcome the whole round exists to remove,
 * reintroduced through a different door.
 *
 * The peer here is a raw pool client taking the two rows in the order every
 * other path takes them. Standing in for `allocateTransaction` rather than
 * calling it keeps the test about the ORDER — which is what the rule in
 * `bank/.claude.md` is about — instead of about auto-allocation config.
 *
 * Both directions are asserted: the confirm now blocks on the bank line and
 * SETTLES once the peer lets go (no deadlock, no 500), and a peer that holds
 * the line past the 5s budget gets the retry refusal rather than a fault.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, confirmMatch, seedBankLine, seedBill, seedInvoice, seedK074, type K074Fixture,
} from './helpers/k074Fixture';

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
const APP_NAME = `k071-lock-order-${process.pid}`;
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

/**
 * Block until the confirm has taken everything it is going to take and is
 * PARKED on the bank line the peer holds.
 *
 * A fixed sleep is not enough: under the old order the confirm has to reach
 * `fetchInvoiceCandidates` and then `bankTxLock` before the pair is a cycle, so
 * a peer that reaches for the document too early finds it free and the test
 * passes on a defect. Waiting for the confirm's own `FOR UPDATE` on
 * `bank_transactions` to show up as blocked makes the cycle deterministic in
 * both directions.
 *
 * SCOPED TO THIS PROCESS'S OWN BACKENDS (`application_name = APP_NAME`). The
 * statement text alone matches ANY session in the cluster blocked on that
 * statement, and this fixture database is shared with the other branches — one
 * of theirs would return the probe early, the peer would take the document
 * before the confirm reached it, and the test would pass on the defect. A false
 * GREEN, not a flake.
 */
async function waitForConfirmParkedOnBankLine(): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND datname = current_database()
         AND application_name = $1
         AND pid <> pg_backend_pid()
         AND query ILIKE '%FROM bank_transactions%'
         AND query ILIKE '%FOR UPDATE%'`,
      [APP_NAME],
    );
    if (rows[0].n > 0) return;
    await wait(50);
  }
  throw new Error('the confirm never blocked on the bank line — the race did not set up');
}

/**
 * Drive one confirm against a peer holding the BANK LINE, who then reaches for
 * the document — the order `allocateTransaction` takes.
 *
 * Returns the confirm's result and whatever the peer's second lock did. The
 * peer's lock is the tell: with the confirm ordered correctly it succeeds
 * immediately, because the confirm is parked on the bank line and holds
 * nothing. With the old order the confirm already holds the document and the
 * pair is a cycle.
 */
async function raceAgainstBankFirstPeer(
  line: string, table: 'customer_invoices' | 'supplier_invoices', document: string,
  candidateType: 'customer_invoice' | 'supplier_invoice',
): Promise<{ confirm: { status: number; body: unknown }; peerError: string | null }> {
  const peer = await pool.connect();
  let peerError: string | null = null;
  try {
    await peer.query('BEGIN');
    // deadlock_timeout is 1s by default; keep every wait below the confirm's
    // own 5s lock_timeout so a genuine deadlock is what fails this test, never
    // a timeout standing in for one.
    await peer.query('SET LOCAL lock_timeout = \'4s\'');
    await peer.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [line]);

    const confirming = confirmMatch(pool, fx, {
      bankTransactionId: line, candidateType, candidateId: document,
    });
    await waitForConfirmParkedOnBankLine();

    try {
      await peer.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [document]);
    } catch (err) {
      peerError = (err as { code?: string }).code ?? (err as Error).message;
    }
    await peer.query('ROLLBACK');
    return { confirm: await confirming, peerError };
  } finally {
    peer.release();
  }
}

it('customer arm: a peer holding the bank line then taking the invoice does not deadlock', async () => {
  const invoice = await seedInvoice(pool, fx, 1000);
  const line = await seedBankLine(pool, fx, 400);

  const { confirm, peerError } = await raceAgainstBankFirstPeer(
    line, 'customer_invoices', invoice, 'customer_invoice',
  );

  // The peer's invoice lock is free: the confirm is waiting on the bank line
  // and holds nothing. Under the OLD order this is 40P01.
  expect(peerError).toBeNull();
  // And the confirm settles once the peer lets go. Under the old order the
  // deadlock victim is the confirm, which answered 500 before 40P01 was mapped
  // and 409 after — either way, not 200.
  expect(confirm.status).toBe(200);

  const { rows } = await pool.query(
    'SELECT amount_paid FROM customer_invoices WHERE id=$1', [invoice],
  );
  expect(Number(rows[0].amount_paid)).toBe(400);
}, 30000);

it('supplier arm: the same pair, the same order, no deadlock', async () => {
  const bill = await seedBill(pool, fx, 1000);
  const line = await seedBankLine(pool, fx, -400);

  const { confirm, peerError } = await raceAgainstBankFirstPeer(
    line, 'supplier_invoices', bill, 'supplier_invoice',
  );

  expect(peerError).toBeNull();
  expect(confirm.status).toBe(200);

  const { rows } = await pool.query(
    'SELECT amount_paid FROM supplier_invoices WHERE id=$1', [bill],
  );
  expect(Number(rows[0].amount_paid)).toBe(400);
}, 30000);

it('a bank line held past the 5s budget is a retry refusal, not a fault', async () => {
  const invoice = await seedInvoice(pool, fx, 1000);
  const line = await seedBankLine(pool, fx, 400);

  const holder = await pool.connect();
  let result;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [line]);
    result = await confirmMatch(pool, fx, {
      bankTransactionId: line, candidateType: 'customer_invoice', candidateId: invoice,
    });
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  // 409, the status `bank-match-confirm` answers a contended line — pre-write,
  // with the retry wording, and never a 500.
  expect(result.status).toBe(409);
  expect(JSON.stringify(result.body)).toMatch(/retry in a moment/i);

  const inv = await pool.query('SELECT amount_paid FROM customer_invoices WHERE id=$1', [invoice]);
  expect(Number(inv.rows[0].amount_paid)).toBe(0);
  const tx = await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [line]);
  expect(tx.rows[0].status).toBe('imported');
}, 30000);
