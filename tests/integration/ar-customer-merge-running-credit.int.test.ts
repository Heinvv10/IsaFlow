/**
 * Customer merge x running on-account credit (ar/customerMergeCredit, 2026-11-15): a merge must not leave the
 * target's running credit (receipts less refunds, by date) below zero on a date it lowers. Judged on the real rows
 * after the move, inside the merge's own savepoint, so a refusal rolls EVERYTHING back (withAuth COMMITs a 4xx — the
 * digest below proves nothing was written). Driven through both real merge routes. Disposable DB only.
 *
 *   (a) combined credit negative on a date -> refused, nothing changes
 *   (b) a source that is negative on its own, nothing on the target covering it -> refused
 *   (c) a normal merge still works
 *   (d) the target's receipts cover the source's refunds on every date -> allowed; a source refund dated BEFORE the
 *       target's receipt -> refused
 * Then the race against the receipt cancel (#1354): whatever order, the target never ends below zero on any date.
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
async function row(cust: string, amount: number, date: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
     VALUES($1,$2,$3::DATE,$4,$5,'confirmed',$6) RETURNING id`,
    [h.companyA, cust, date, amount, amount < 0 ? 'refund' : 'eft', h.admin]);
  return rows[0]!.id;
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

async function refused(body: Record<string, unknown>) {
  const before = await h.snapshot();
  const result = await h.merge(body);
  expect(result.state.statusCode).toBe(400);
  expect(await h.snapshot()).toBe(before); // every census table, both tenants, byte for byte
  const { rows } = await pool.query('SELECT name, deleted_at FROM customers WHERE id=$1', [source]);
  expect(rows[0]).toEqual({ name: 'MCR Source Co', deleted_at: null });
  return JSON.stringify(result.state.body);
}

describe('a merge that would leave the target below zero', () => {
  it('(a) is refused on a date the merge lowers, naming both customers and the date, and changes nothing', async () => {
    await row(source, 40, '2026-05-01');
    await row(source, -100, '2026-05-10'); // the source is -60 on its own from 05-10
    await row(target, 30, '2026-05-05');   // 40 + 30 - 100 = -30 on 05-10
    await h.footprint(h.companyA, source, 's');
    await h.footprint(h.companyA, target, 't');
    await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [target]);
    const text = await refused({ source_id: source, target_id: target });
    expect(text).toMatch(/Merging MCR Source Co into MCR Target Co would leave MCR Target Co owing the company/);
    expect(text).toMatch(/from 2026-05-10/);
    expect(text).toMatch(/Nothing was merged/);
  });

  it('(b) is refused when the source is negative on its own and nothing on the target covers it', async () => {
    await row(source, -50, '2026-05-10');
    await refused({ source_id: source, target_id: target });
  });

  it('(b) the same, through the duplicates page route (the source is the duplicate)', async () => {
    await row(source, -50, '2026-05-10');
    const before = await h.snapshot();
    const result = await h.mergeDuplicate({ entityType: 'customer', primaryId: target, duplicateId: source });
    expect(result.state.statusCode).toBe(400);
    expect(JSON.stringify(result.state.body)).toMatch(/owing the company/);
    expect(await h.snapshot()).toBe(before);
  });

  it('(d) a source refund dated BEFORE the target\'s receipt is refused, though the totals net to zero', async () => {
    await row(source, -100, '2026-05-05');
    await row(target, 100, '2026-05-10');
    const text = await refused({ source_id: source, target_id: target });
    expect(text).toMatch(/from 2026-05-05/);
  });
});

describe('a merge that leaves every date at or above zero', () => {
  it('(c) still works: every census table moved, the source soft-deleted, the credit unchanged', async () => {
    await row(source, 40, '2026-05-01');
    await row(target, 60, '2026-05-02');
    await h.footprint(h.companyA, source, 's');
    await h.footprint(h.companyA, target, 't');
    await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [target]);
    const result = await h.merge({ source_id: source, target_id: target });
    expect(result.state.statusCode).toBe(200);
    expect(await runningCredit(target)).toEqual([
      { d: '2026-05-01', credit: 40 }, { d: '2026-05-02', credit: 100 }, { d: '2026-06-03', credit: 180 }]);
    const { rows } = await pool.query('SELECT deleted_at IS NOT NULL AS gone FROM customers WHERE id=$1', [source]);
    expect(rows[0].gone).toBe(true);
  });

  it('(d) the target\'s receipts cover the source\'s refunds on every date: allowed', async () => {
    await row(source, 100, '2026-05-01');
    await row(source, -150, '2026-05-10'); // -50 on its own from 05-10
    await row(target, 60, '2026-05-05');   // 100 + 60 - 150 = 10 on 05-10
    const result = await h.merge({ source_id: source, target_id: target });
    expect(result.state.statusCode).toBe(200);
    expect((await runningCredit(target)).map((r) => r.credit)).toEqual([100, 160, 10]);
  });

  it('(d) a refund dated the SAME day as the covering receipt nets, as the rule counts a day at a time', async () => {
    await row(source, -100, '2026-05-10');
    await row(target, 100, '2026-05-10');
    expect((await h.merge({ source_id: source, target_id: target })).state.statusCode).toBe(200);
  });

  it('a cancelled source receipt or refund is not credit: it neither covers nor deepens', async () => {
    const dead = await row(source, -500, '2026-05-10');
    await pool.query("UPDATE customer_payments SET status='cancelled' WHERE id=$1", [dead]);
    await row(source, 20, '2026-05-01');
    expect((await h.merge({ source_id: source, target_id: target })).state.statusCode).toBe(200);
  });

  it('a target already below zero on a date the merge does not lower stays mergeable (the source adds only credit)', async () => {
    await row(target, -40, '2026-05-01'); // legacy: negative on its own
    await row(source, 25, '2026-05-02');
    expect((await h.merge({ source_id: source, target_id: target })).state.statusCode).toBe(200);
  });

  it('...but a merge that deepens it is refused', async () => {
    await row(target, -40, '2026-05-01');
    await row(source, -10, '2026-05-02');
    await refused({ source_id: source, target_id: target });
  });

  it('a source with no receipts at all merges as before, whatever the target\'s credit', async () => {
    await row(target, -40, '2026-05-01');
    expect((await h.merge({ source_id: source, target_id: target })).state.statusCode).toBe(200);
  });
});

describe('the merge and the #1354 receipt cancel agree, in either order', () => {
  it('merged first: cancelling the target receipt that now covers the moved refund is refused', async () => {
    const covering = await row(target, 100, '2026-05-01');
    await row(source, -100, '2026-05-05');
    expect((await h.merge({ source_id: source, target_id: target })).state.statusCode).toBe(200);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const err = await als.run({ client, userId: h.admin, companyId: h.companyA, claims: {} } as never,
        () => cancelCustomerPayment(h.companyA, covering, h.admin)).catch((e: { code?: string }) => e);
      await client.query('ROLLBACK');
      expect((err as { code?: string }).code).toBe('RECEIPT_REFUSED');
    } finally { client.release(); }
  });
});

describe('a merge racing a receipt cancellation on the target (#1354 lock order)', () => {
  it('never deadlocks and never leaves the target below zero on any date, whichever commits first', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 10; round++) {
      await h.wipe();
      source = await h.customer(h.companyA, 'MCR Race Source');
      target = await h.customer(h.companyA, 'MCR Race Target');
      const covering = await row(target, 100, '2026-05-01');
      await row(source, -100, '2026-05-05'); // the target's receipt is what keeps the merge legal
      const cancel = async (): Promise<string> => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await als.run({ client, userId: h.admin, companyId: h.companyA, claims: {} } as never,
            () => cancelCustomerPayment(h.companyA, covering, h.admin));
          await client.query('COMMIT');
          return 'cancelled';
        } catch (e) {
          await client.query('ROLLBACK');
          return String((e as { code?: string }).code ?? (e as Error).message);
        } finally { client.release(); }
      };
      // The cancel starts 0, 3, 6 ... ms after the merge, so both orders and the overlap are met.
      const [merged, cancelled] = await Promise.all([
        h.merge({ source_id: source, target_id: target }),
        new Promise((r) => setTimeout(r, round * 3)).then(cancel)]);
      outcomes.push(`${merged.state.statusCode}/${cancelled}`);
      expect([200, 400, 409]).toContain(merged.state.statusCode);
      expect(cancelled).not.toMatch(/40P01|deadlock/i);
      // The source is negative on its own by construction; the target is what the guard protects.
      for (const day of await runningCredit(target)) expect({ ...day, ok: day.credit >= 0 }).toMatchObject({ ok: true });
    }
    // The only two consistent outcomes: merged and the cancel refused (the refund now spends the receipt), or the
    // cancel committed first and the merge was refused. Never both.
    for (const o of outcomes) {
      expect(o).toMatch(/^(200\/(RECEIPT_REFUSED|PAYMENT_LOCK_TIMEOUT)|400\/(cancelled|PAYMENT_LOCK_TIMEOUT)|409\/\w+)$/);
    }
  }, 120_000);
});
