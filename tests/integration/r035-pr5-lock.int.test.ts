/**
 * R-035 PR5: approveSupplierPayment used to read the payment unlocked and
 * UPDATE it with no status predicate. It now takes the payment's row lock
 * first — bounded by the 5s lock_timeout its siblings use — and decides the
 * status and the approval gate on a row nobody can change underneath:
 *  - a held payment answers the retryable 503 rather than waiting without end;
 *  - a cancel that lands while the approve waits is respected — the approve
 *    refuses the cancelled payment instead of writing it back to 'approved'.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr5, payCompany, paymentState, payRoutes, plantPayment } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const r = payRoutes(tokens);

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(() => cleanupPr5(pool, companies, [a]));

async function holding(hold: (client: PoolClient) => Promise<unknown>) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await hold(client);
  return async (commit: boolean) => {
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    client.release();
  };
}

describe('the approve lock', () => {
  it('a payment another request holds answers 503 "retry" after the bounded wait, and nothing is written', async () => {
    const { company: c, bank } = await payCompany(pool, [[a, 'owner']], companies);
    const p = await plantPayment(pool, c, a, bank);
    const release = await holding((cl) => cl.query('SELECT 1 FROM supplier_payments WHERE id = $1 FOR UPDATE', [p.id]));
    try {
      const res = await r.payment(a, c, 'approve', p.id);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(503);
      expect(messageOf(res)).toMatch(/being processed by another request — retry/);
    } finally {
      await release(false);
    }
    expect((await paymentState(pool, p.id)).status).toBe('draft');
  }, 20_000);

  it('a cancel committed while the approve waits is respected: the approve refuses, the payment stays cancelled', async () => {
    const { company: c, bank } = await payCompany(pool, [[a, 'owner']], companies);
    const p = await plantPayment(pool, c, a, bank);
    const release = await holding((cl) => cl.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [p.id]));
    const approving = r.payment(a, c, 'approve', p.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await release(true);
    const res = await approving;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toBe('Cannot approve payment with status: cancelled');
    expect((await paymentState(pool, p.id)).status).toBe('cancelled');
  });
});
