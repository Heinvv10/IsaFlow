/**
 * K-040 — the billed-count guard must undo the invoice it already wrote.
 *
 * `generateWipInvoice` builds the invoice inside a savepoint and refuses the run
 * when `markEntriesBilled` marks fewer entries than were selected. The route
 * answers a caught service error with a 400 and `withAuth` COMMITs that, so a
 * guard that only throws would leave behind the orphan invoice it exists to
 * prevent.
 *
 * The row lock makes a short count unreachable through two real runs, so
 * `markEntriesBilled` is stubbed here. Everything else — the invoice, its lines,
 * the savepoint and its rollback — runs against the real database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const { markEntriesBilledMock } = vi.hoisted(() => ({ markEntriesBilledMock: vi.fn() }));

vi.mock('@/modules/accounting/services/practice/practiceTimeEntryWorkflow', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  markEntriesBilled: markEntriesBilledMock,
}));

const { als } = await import('@/lib/als');
const { generateWipInvoice } = await import(
  '@/modules/accounting/services/practice/practiceWipService'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const clientId = crypto.randomUUID();
const customerId = crypto.randomUUID();
const userId = crypto.randomUUID();
const entryId = crypto.randomUUID();
const entry2Id = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'K-040 rollback']);
  await pool.query('INSERT INTO customers(id,company_id,name,is_active) VALUES($1,$2,$3,TRUE)',
    [customerId, companyId, 'K-040 rollback customer']);
  await pool.query(
    `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
     VALUES($1,$2,'K-040 rollback client','hourly','active',$3)`,
    [clientId, companyId, customerId]);
  for (const id of [entryId, entry2Id]) {
    await pool.query(
      `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,
         billable,status,practice_client_id,applied_rate,line_total,approved_at)
       VALUES($1,$2,$3,'K-040 rollback work','2026-06-01',10,TRUE,'approved',$4,1000,10000,now())`,
      [id, companyId, userId, clientId]);
  }
});

afterAll(async () => {
  await pool.query(
    'DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)',
    [companyId]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM time_entries WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM practice_clients WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM customers WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
  await pool.end();
});

describe('K-040 billed-count guard', () => {
  it('rolls the invoice back and leaves the transaction usable when a peer took an entry', async () => {
    markEntriesBilledMock.mockResolvedValueOnce(1); // one of the two selected entries lost
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        als.run({ client, userId, claims: {} } as never, () =>
          generateWipInvoice(companyId, userId, {
            practiceClientId: clientId, timeEntryIds: [entryId, entry2Id],
            invoiceDate: '2026-06-30',
          })),
      ).rejects.toThrow(/billed concurrently/);

      // Same connection: the savepoint rolled back, so the transaction still works
      // and the invoice it had already written is gone.
      const inTx = await client.query(
        `SELECT (SELECT count(*)::int FROM customer_invoices WHERE company_id=$1) AS invoices,
                (SELECT count(*)::int FROM customer_invoice_items
                  WHERE time_entry_id = ANY($2::uuid[])) AS lines`,
        [companyId, [entryId, entry2Id]]);
      expect(inTx.rows[0].invoices).toBe(0);
      expect(inTx.rows[0].lines).toBe(0);
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM customer_invoices WHERE company_id=$1) AS invoices,
              (SELECT count(*)::int FROM time_entries
                WHERE company_id=$1 AND status='approved' AND billed_at IS NULL) AS unbilled`,
      [companyId]);
    expect(rows[0].invoices).toBe(0);
    expect(rows[0].unbilled).toBe(2);
  });
});
