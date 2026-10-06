/**
 * R-035 PR4 review F2: the row lock approveCustomerInvoice takes for the
 * approval gate's read.
 *
 *  - It is FOR NO KEY UPDATE, not FOR UPDATE: inserting a row that references
 *    the invoice (an allocation, a portal view, a dispute, an invoice line)
 *    takes FOR KEY SHARE on it, which FOR UPDATE would block for the whole
 *    approve — even with enforcement off.
 *  - It is taken only on an approvable invoice (draft / pending approval): a
 *    request that cannot approve waits on nobody.
 *  - It still closes the gate's check-then-act: an edit in flight when the
 *    approve starts is waited for, and the gate judges the edited content
 *    (409 STALE) — not the content before it, which the backstop would then
 *    refuse as a 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes, invoiceState, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

const company = () => invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);

/** Run `hold` in an open transaction on its own connection; `release` commits (or rolls back) it. */
async function holding(hold: (client: PoolClient) => Promise<unknown>) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await hold(client);
  return {
    release: async (commit: boolean) => {
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      client.release();
    },
  };
}

describe('the approve lock', () => {
  it('does not wait on a concurrent insert that references the invoice (FOR KEY SHARE)', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, u.a);
    const held = await holding((cl) => cl.query(
      "INSERT INTO customer_invoice_items(invoice_id,description,unit_price,amount) VALUES($1,'pending line',1,1)", [inv.id]));
    try {
      const started = Date.now();
      const res = await r.approve(u.a, c, inv.id);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await held.release(false);
    }
  });

  it('takes no lock on an invoice that cannot be approved: refused at once, not after a wait', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, u.a, { status: 'sent' });
    const held = await holding((cl) => cl.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [inv.id]));
    try {
      const started = Date.now();
      const res = await r.approve(u.a, c, inv.id);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await held.release(false);
    }
  });

  it('waits for an edit in flight, and the gate judges the edited content: 409 STALE, nothing posted', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice' });
    await enforceInvoices(pool, c, u.b);
    const inv = await plantInvoice(pool, c, u.a);
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    const held = await holding((cl) => cl.query(
      "UPDATE customer_invoices SET invoice_date = DATE '2026-09-15' WHERE id = $1", [inv.id]));
    const approving = r.approve(u.a, c, inv.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await held.release(true);
    const res = await approving;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_STALE');
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', journals: 0 });
  });
});
