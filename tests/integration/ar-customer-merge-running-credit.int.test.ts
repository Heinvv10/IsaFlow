/**
 * Customer merge x running on-account credit (ar/customerMergeCredit, 2026-11-15, symmetric after review round 1): the
 * merged account's running credit (receipts less refunds, by date, each at its unapplied remainder) must not be below
 * zero on ANY date, whichever customer is the source. Judged on the real rows after the move, inside the merge's own
 * savepoint, so a refusal rolls EVERYTHING back (withAuth COMMITs a 4xx — the digest below proves nothing was
 * written). Driven through both real merge routes. Disposable DB only.
 *
 *   (a) combined credit negative on a date -> refused, in BOTH directions, nothing changes
 *   (b) a customer negative on its own, nothing covering it -> refused in both directions
 *   (c) a normal merge still works
 *   (d) one side's receipts cover the other's refunds on every date -> allowed in both directions; a refund dated
 *       BEFORE the covering receipt -> refused in both
 * Then the merge against the #1354 receipt cancel, in both orders, held apart by a barrier.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k061 } from './k061-customer-merge.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const h = k061(pool);
let source = '';
let target = '';

beforeAll(h.setUp);
afterAll(h.tearDown);
beforeEach(async () => {
  await h.wipe();
  source = await h.customer(h.companyA, 'MCR Source Co');
  target = await h.customer(h.companyA, 'MCR Target Co');
});

/** A receipt (amount > 0) or a refund (amount < 0, as the refund path stores it) on `cust`. */
async function row(
  cust: string, amount: number, date: string, company = h.companyA, status = 'confirmed',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
     VALUES($1,$2,$3::DATE,$4,$5,$6,$7) RETURNING id`,
    [company, cust, date, amount, amount < 0 ? 'refund' : 'eft', status, h.admin]);
  return rows[0]!.id;
}

/** An approved invoice of `cust` and `amount` of `receipt` applied to it (the receipt's remainder falls by that). */
async function allocate(receipt: string, cust: string, amount: number): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_invoices(company_id,invoice_number,customer_id,invoice_date,subtotal,total_amount,status,created_by)
     VALUES($1,$2,$3,'2026-04-01',500,500,'approved',$4) RETURNING id`,
    [h.companyA, `MCR-${crypto.randomUUID().slice(0, 8)}`, cust, h.admin]);
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)',
    [receipt, rows[0]!.id, amount]);
}

/** The target's running credit by date, oldest first, over every live row it holds. */
async function runningCredit(cust: string): Promise<Array<{ d: string; credit: number }>> {
  const { rows } = await pool.query<{ d: string; credit: string }>(
    `SELECT to_char(payment_date,'YYYY-MM-DD') AS d,
            SUM(SUM(total_amount)) OVER (ORDER BY payment_date) AS credit
     FROM customer_payments WHERE company_id=$1 AND client_id=$2 AND status <> 'cancelled'
     GROUP BY payment_date ORDER BY payment_date`, [h.companyA, cust]);
  return rows.map((r) => ({ d: r.d, credit: Number(r.credit) }));
}

/** One merge that must be refused: 400, the savepoint rolled back (every census table byte for byte), source live. */
async function refused(from: string, into: string) {
  const before = await h.snapshot();
  const result = await h.merge({ source_id: from, target_id: into });
  expect(result.state.statusCode).toBe(400);
  expect(await h.snapshot()).toBe(before);
  const { rows } = await pool.query('SELECT deleted_at FROM customers WHERE id=$1', [from]);
  expect(rows[0].deleted_at).toBeNull();
  return JSON.stringify(result.state.body);
}
const merged = async (from: string, into: string) => (await h.merge({ source_id: from, target_id: into })).state.statusCode;

/** `seed(a, b)` writes the same two ledgers each time; `a` and `b` are the customers, in whichever role. */
async function bothWays(seed: (a: string, b: string) => Promise<void>, verdict: 'refused' | 'allowed') {
  for (const flip of [false, true]) {
    await h.wipe();
    source = await h.customer(h.companyA, 'MCR Source Co');
    target = await h.customer(h.companyA, 'MCR Target Co');
    const [a, b] = flip ? [target, source] : [source, target];
    await seed(a, b);
    if (verdict === 'refused') await refused(a, b);
    else expect(await merged(a, b)).toBe(200);
  }
}

describe('a merge that would leave the merged account below zero, in either direction', () => {
  it('(a) refuses A->B and B->A alike on the same date, naming both customers and the date', async () => {
    await bothWays(async (a, b) => {
      await row(a, 40, '2026-05-01');
      await row(a, -100, '2026-05-10'); // A is -60 on its own from 05-10
      await row(b, 30, '2026-05-05');   // 40 + 30 - 100 = -30 on 05-10, whoever is the source
    }, 'refused');
    // and the wording, once, with both customers' own footprints in the snapshot
    await h.wipe();
    source = await h.customer(h.companyA, 'MCR Source Co');
    target = await h.customer(h.companyA, 'MCR Target Co');
    await row(source, 40, '2026-05-01'); await row(source, -100, '2026-05-10'); await row(target, 30, '2026-05-05');
    await h.footprint(h.companyA, source, 's');
    await h.footprint(h.companyA, target, 't');
    await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [target]);
    const text = await refused(source, target);
    expect(text).toMatch(/Merging MCR Source Co into MCR Target Co would leave MCR Target Co owing the company/);
    expect(text).toMatch(/from 2026-05-10/);
    expect(text).toMatch(/Nothing was merged/);
    expect(text).not.toMatch(/other way/i);
  });

  it('(b) refuses a customer negative on its own, the other empty, in both directions', async () => {
    await bothWays(async (a) => { await row(a, -50, '2026-05-10'); }, 'refused');
  });

  it('(b) the same, through the duplicates page route (the source is the duplicate)', async () => {
    await row(source, -50, '2026-05-10');
    const before = await h.snapshot();
    const result = await h.mergeDuplicate({ entityType: 'customer', primaryId: target, duplicateId: source });
    expect(result.state.statusCode).toBe(400);
    expect(JSON.stringify(result.state.body)).toMatch(/owing the company/);
    expect(await h.snapshot()).toBe(before);
  });

  it('(d) a refund dated BEFORE the covering receipt is refused in both directions, though the totals net to zero', async () => {
    await bothWays(async (a, b) => { await row(a, -100, '2026-05-05'); await row(b, 100, '2026-05-10'); }, 'refused');
  });

  it('a customer already negative is refused whichever side it is, with or without a receipt on the other', async () => {
    await bothWays(async (a, b) => { await row(a, -40, '2026-05-01'); await row(b, 25, '2026-05-02'); }, 'refused');
    await bothWays(async (a) => { await row(a, -40, '2026-05-01'); }, 'refused'); // the other customer has no receipt at all
  });

  it('...and so is a merge that deepens an existing negative', async () => {
    await bothWays(async (a, b) => { await row(a, -40, '2026-05-01'); await row(b, -10, '2026-05-02'); }, 'refused');
  });
});

describe('a merge that leaves every date at or above zero', () => {
  it('(c) still works: every census table moved, the source soft-deleted, the credit unchanged', async () => {
    await row(source, 40, '2026-05-01');
    await row(target, 60, '2026-05-02');
    await h.footprint(h.companyA, source, 's');
    await h.footprint(h.companyA, target, 't');
    await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [target]);
    expect(await merged(source, target)).toBe(200);
    expect(await runningCredit(target)).toEqual([
      { d: '2026-05-01', credit: 40 }, { d: '2026-05-02', credit: 100 }, { d: '2026-06-03', credit: 180 }]);
    const { rows } = await pool.query('SELECT deleted_at IS NOT NULL AS gone FROM customers WHERE id=$1', [source]);
    expect(rows[0].gone).toBe(true);
  });

  it('(d) a refund covered by the other side\'s receipts on every date is allowed in both directions', async () => {
    await bothWays(async (a, b) => {
      await row(a, 100, '2026-05-01'); await row(a, -150, '2026-05-10'); // A alone is -50 from 05-10
      await row(b, 60, '2026-05-05');                                     // 100 + 60 - 150 = 10 on 05-10
    }, 'allowed');
    expect((await runningCredit(target)).map((r) => r.credit).every((c) => c >= 0)).toBe(true);
  });

  it('a merge that moves no receipt, into a customer at or above zero, merges as before', async () => {
    await row(target, 40, '2026-05-01');
    expect(await merged(source, target)).toBe(200);
  });

  it('a cancelled receipt or refund is not credit: it neither covers nor deepens', async () => {
    const dead = await row(source, -500, '2026-05-10');
    await pool.query("UPDATE customer_payments SET status='cancelled' WHERE id=$1", [dead]);
    await row(source, 20, '2026-05-01');
    expect(await merged(source, target)).toBe(200);
  });

  it('several receipts and refunds on one date net to one figure for that date', async () => {
    await bothWays(async (a, b) => {
      await row(a, 50, '2026-05-10'); await row(b, 50, '2026-05-10');
      await row(a, -60, '2026-05-10'); await row(b, -40, '2026-05-10'); // 100 in, 100 out on the day: 0, not below
    }, 'allowed');
    await bothWays(async (a, b) => {
      await row(a, 50, '2026-05-10'); await row(b, 50, '2026-05-10');
      await row(a, -60, '2026-05-10'); await row(b, -41, '2026-05-10'); // one rand over
    }, 'refused');
  });
});

describe('what counts as credit: the remainder basis, and this company only', () => {
  it('a PARTLY applied receipt covers a refund only for its unapplied remainder, in both directions', async () => {
    await bothWays(async (a, b) => {
      const r = await row(a, 100, '2026-05-01');
      await allocate(r, a, 70);                   // remainder 30
      await row(b, -50, '2026-05-10');            // 30 - 50 = -20 although the receipt total is 100
    }, 'refused');
    await bothWays(async (a, b) => {
      const r = await row(a, 100, '2026-05-01');
      await allocate(r, a, 70);
      await row(b, -30, '2026-05-10');            // exactly the remainder
    }, 'allowed');
  });

  it('a FULLY applied receipt is no credit at all: the refund it can no longer cover is refused', async () => {
    await bothWays(async (a, b) => {
      const r = await row(a, 100, '2026-05-01');
      await allocate(r, a, 100);
      await row(b, -10, '2026-05-10');
    }, 'refused');
  });

  it('another company\'s rows naming the same customer id are ignored', async () => {
    await row(target, 40, '2026-05-01');
    await row(target, -500, '2026-05-02', h.companyB); // client_id is an FK on id only; not this company's ledger
    await row(source, 10, '2026-05-03');
    expect(await merged(source, target)).toBe(200);
  });
});

describe('which statuses count as credit: every row but cancelled (the AR basis)', () => {
  it('a DRAFT receipt covers a moved refund, in both directions', async () => {
    await bothWays(async (a, b) => {
      await row(a, 100, '2026-05-01', h.companyA, 'draft');
      await row(b, -100, '2026-05-10');
    }, 'allowed');
  });

  it('a RECONCILED receipt covers a moved refund, in both directions', async () => {
    await bothWays(async (a, b) => {
      await row(a, 100, '2026-05-01', h.companyA, 'reconciled');
      await row(b, -100, '2026-05-10');
    }, 'allowed');
  });

  it('a CANCELLED receipt covers nothing, in both directions (a cancelled refund deepens nothing either)', async () => {
    await bothWays(async (a, b) => {
      await row(a, 100, '2026-05-01', h.companyA, 'cancelled');
      await row(b, -100, '2026-05-10');
    }, 'refused');
    await bothWays(async (a, b) => {
      await row(a, 100, '2026-05-01');
      await row(b, -100, '2026-05-10');
      await row(b, -500, '2026-05-11', h.companyA, 'cancelled');
    }, 'allowed');
  });
});

describe('the merge and the #1354 receipt cancel agree, in either order (held apart, not raced)', () => {
  /** Resolve once a backend is waiting on a lock in a statement matching `like`. */
  async function waitBlocked(like: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()`, [like]);
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`nothing blocked on ${like}`);
  }
  const cancelOf = (receipt: string) => (async (): Promise<string> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: h.admin, companyId: h.companyA, claims: {} } as never,
        () => cancelCustomerPayment(h.companyA, receipt, h.admin));
      await client.query('COMMIT');
      return 'cancelled';
    } catch (e) {
      await client.query('ROLLBACK');
      return String((e as { code?: string }).code ?? (e as Error).message);
    } finally { client.release(); }
  })();

  it('merged first: the target receipt that now covers the moved refund can no longer be cancelled', async () => {
    const covering = await row(target, 100, '2026-05-01');
    await row(source, -100, '2026-05-05');
    // The cancel is held on the receipt row; the merge runs and commits; the cancel is then judged on the merged ledger.
    const hold = await pool.connect();
    await hold.query('BEGIN');
    await hold.query('SELECT id FROM customer_payments WHERE id=$1 FOR UPDATE', [covering]);
    const cancel = cancelOf(covering);
    await waitBlocked('%customer_payments%');
    expect(await merged(source, target)).toBe(200);
    await hold.query('COMMIT');
    hold.release();
    expect(await cancel).toBe('RECEIPT_REFUSED');
    expect((await runningCredit(target)).every((r) => r.credit >= 0)).toBe(true);
  });

  it('cancelled first: the merge waits for the customer row, then reads the receipt cancelled and refuses', async () => {
    const covering = await row(target, 100, '2026-05-01');
    await row(source, -100, '2026-05-05');
    // What a cancel does: holds the target's customer row, then flips the receipt, then commits.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM customers WHERE id=$1 FOR NO KEY UPDATE', [target]);
    const before = await h.snapshot();
    const merge = h.merge({ source_id: source, target_id: target });
    await waitBlocked('%FROM customers%');
    await holder.query("UPDATE customer_payments SET status='cancelled' WHERE id=$1", [covering]);
    await holder.query('COMMIT');
    holder.release();
    const result = await merge;
    expect(result.state.statusCode).toBe(400);
    expect(JSON.stringify(result.state.body)).toMatch(/owing the company/);
    // only the cancel's own write remains
    expect(await h.snapshot()).not.toBe(before);
    expect((await pool.query('SELECT deleted_at FROM customers WHERE id=$1', [source])).rows[0].deleted_at).toBeNull();
    expect((await pool.query('SELECT client_id FROM customer_payments WHERE company_id=$1 AND total_amount < 0', [h.companyA])).rows[0].client_id)
      .toBe(source);
  });

  it('racing them with staggered starts never deadlocks, and never ends both merged and cancelled', async () => {
    for (let round = 0; round < 10; round++) {
      await h.wipe();
      source = await h.customer(h.companyA, 'MCR Race Source');
      target = await h.customer(h.companyA, 'MCR Race Target');
      const covering = await row(target, 100, '2026-05-01');
      await row(source, -100, '2026-05-05');
      const [result, cancelled] = await Promise.all([
        h.merge({ source_id: source, target_id: target }),
        new Promise((r) => setTimeout(r, round * 3)).then(() => cancelOf(covering))]);
      const outcome = `${result.state.statusCode}/${cancelled}`;
      expect(outcome).toMatch(/^(200\/(RECEIPT_REFUSED|PAYMENT_LOCK_TIMEOUT)|400\/(cancelled|PAYMENT_LOCK_TIMEOUT)|409\/\w+)$/);
      expect(cancelled).not.toMatch(/40P01|deadlock/i);
      for (const day of await runningCredit(target)) expect({ ...day, ok: day.credit >= 0 }).toMatchObject({ ok: true });
    }
  }, 120_000);
});
