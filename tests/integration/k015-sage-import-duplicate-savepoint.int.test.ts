/**
 * Round-4 N1 — `sageImportService.importSupplierInvoices` inserted each record
 * with no savepoint, inside a per-record `try` whose catch immediately runs
 * `UPDATE sage_supplier_invoices SET migration_status = 'failed'`. Any SQL
 * failure on a record therefore aborted the request transaction, the marker
 * raised 25P02, that escaped to `failRun()` — more SQL on the same dead
 * transaction — and every invoice the run had already imported rolled back.
 *
 * Two things are stated here rather than papered over.
 *
 * 1. `importSupplierInvoices` cannot be driven end to end on a database built
 *    from this repo's migrations. Its SELECT names `sage_invoice_id`,
 *    `sage_supplier_id`, `subtotal`, `tax_amount`, `supplier_id`, `raw_data`,
 *    `line_items` and four more columns that `sage_supplier_invoices` does not
 *    have — migration 205 creates ten columns and 288 adds `company_id`. The
 *    first statement raises 42703 today. That is the K-015 defect class in
 *    another service, registered separately and NOT fixed here.
 * 2. The trigger originally reported for this hazard was migration 625's unique
 *    index. That index no longer exists: a production probe found groups of
 *    55-79 live invoices sharing one fingerprint, so the column cannot carry a
 *    unique constraint. The savepoint still matters — the poisoning shape is
 *    generic to any SQL failure on a record, which these tests use instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { sql, withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K015SAGE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplierId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

describeIfDb('the Sage importer survives a record that fails', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'K015 sage ' + TAG}, ${TAG}, NOW())`;
    supplierId = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM sage_supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  /** The INSERT the importer makes, in the shape it makes it. */
  const insertBill = (c: PoolClient, invoiceNumber: string, invoiceDate: string) => () =>
    c.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, due_date,
          subtotal, tax_amount, total_amount, status, created_by, duplicate_fingerprint)
       VALUES ($1, $2, $3, $4, '2026-07-30', 100, 15, 115, 'approved', $5, $6)
       RETURNING id`,
      [COMPANY, supplierId, invoiceNumber, invoiceDate, USER, `no-vat|${invoiceNumber}|115`],
    );

  const staging = async (c: PoolClient, n: string) => (await c.query(
    `INSERT INTO sage_supplier_invoices
       (company_id, sage_id, invoice_number, supplier_name, invoice_date, total_amount, migration_status)
     VALUES ($1, $2, $3, $4, '2026-06-30', 115, 'pending') RETURNING id`,
    [COMPANY, `${TAG}-${n}`, n, `ACME ${TAG}`],
  )).rows[0].id;

  it('the savepoint keeps the transaction usable, so the status marker still lands', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const good = await run(c, () => insertBill(c, `${TAG}-ok`, '2026-06-30')());
      expect(good.rows).toHaveLength(1);
      const stagingId = await staging(c, `${TAG}-bad`);

      // 22007 on the record: the shape of any per-record SQL failure.
      let caught: unknown = null;
      await run(c, async () => {
        try {
          await withSavepoint('sage_supplier_invoice_record', insertBill(c, `${TAG}-bad`, 'not-a-date'));
        } catch (err) {
          caught = err;
        }
      });
      expect((caught as { code?: string }).code).toBe('22007');

      // THE POINT: without the savepoint this UPDATE raises 25P02, escapes to
      // failRun() and takes the whole run down. It must land.
      const marked = await c.query(
        `UPDATE sage_supplier_invoices SET migration_status = 'failed'
          WHERE id = $1 AND company_id = $2 RETURNING migration_status`,
        [stagingId, COMPANY],
      );
      expect(marked.rows[0].migration_status).toBe('failed');

      // And the record the run had already imported is still there.
      const kept = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-ok`],
      )).rows[0];
      expect(kept.n).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('without the savepoint the follow-up UPDATE dies with 25P02', async () => {
    // The defect itself, so the test above is measuring something real.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await expect(insertBill(c, `${TAG}-nosp`, 'not-a-date')())
        .rejects.toMatchObject({ code: '22007' });

      await expect(c.query(
        `UPDATE sage_supplier_invoices SET migration_status = 'failed' WHERE company_id = $1`,
        [COMPANY],
      )).rejects.toMatchObject({ code: '25P02' });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('the fingerprint column takes many rows with the same value, as production has', async () => {
    // Why migration 625 carries no unique index. A supplier billing repeatedly
    // with no invoice number and a zero total produces one fingerprint for all
    // of them, and those rows are real and already stored.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      for (let n = 0; n < 4; n++) {
        await c.query(
          `INSERT INTO supplier_invoices
             (company_id, supplier_id, invoice_number, invoice_date, due_date,
              subtotal, tax_amount, total_amount, status, created_by, duplicate_fingerprint)
           VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', 0, 0, 0, 'approved', $4, 'no-vat|no-inv|0')`,
          [COMPANY, supplierId, `${TAG}-degenerate-${n}`, USER],
        );
      }
      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND duplicate_fingerprint = 'no-vat|no-inv|0'`,
        [COMPANY],
      )).rows[0];
      expect(rows.n).toBe(4);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
