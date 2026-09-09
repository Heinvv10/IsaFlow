/**
 * Round-4 N1 — migration 625 makes a 23505 reachable on `supplier_invoices` for
 * the first time, and `sageImportService.importSupplierInvoices` inserted each
 * record with no savepoint. An aborted transaction then met the catch's
 * `UPDATE sage_supplier_invoices SET migration_status = 'failed'`, which raised
 * 25P02, escaped to `failRun()` — more SQL on the same dead transaction — and
 * rolled back every invoice the run had already imported.
 *
 * IMPORTANT, and stated rather than papered over: `importSupplierInvoices`
 * cannot be driven end to end on a database built from this repo's migrations.
 * Its SELECT names `sage_invoice_id`, `sage_supplier_id`, `subtotal`,
 * `tax_amount`, `supplier_id`, `raw_data`, `line_items` and four more columns
 * that `sage_supplier_invoices` does not have — migration 205 creates ten
 * columns and 288 adds `company_id`. The first statement of the function raises
 * 42703 today. That is the K-015 defect class in another service and is
 * registered separately; it is NOT fixed here.
 *
 * So these tests prove the mechanism at the level that can be proven on the real
 * database: the savepoint contains the 23505, the follow-up status UPDATE lands
 * instead of raising 25P02, and a duplicate is recognised through the wrapper
 * that replaces its message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql, withSavepoint } from '@/lib/neon';
import {
  computeFingerprint,
  insertNamingDuplicate,
  isDuplicateFingerprintViolation,
} from '@/modules/accounting/services/capture/captureDeduplicationService';

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

describeIfDb('the Sage importer survives a duplicate that migration 625 now refuses', () => {
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
  const insertBill = (c: PoolClient, invoiceNumber: string, fingerprint: string) => () =>
    c.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, due_date,
          subtotal, tax_amount, total_amount, status, created_by, duplicate_fingerprint)
       VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', 100, 15, 115, 'approved', $4, $5)
       RETURNING id`,
      [COMPANY, supplierId, invoiceNumber, USER, fingerprint],
    );

  it('the savepoint keeps the transaction usable, so the status marker still lands', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const staging = (await c.query(
        `INSERT INTO sage_supplier_invoices
           (company_id, sage_id, invoice_number, supplier_name, invoice_date, total_amount, migration_status)
         VALUES ($1, $2, $3, $4, '2026-06-30', 115, 'pending') RETURNING id`,
        [COMPANY, `${TAG}-sage`, `${TAG}-dup`, `ACME ${TAG}`],
      )).rows[0].id;

      const fingerprint = computeFingerprint(null, `${TAG}-dup`, 115);
      await run(c, () => insertBill(c, `${TAG}-dup`, fingerprint)());

      // Second record, same supplier, same fingerprint: 23505.
      let caught: unknown = null;
      await run(c, async () => {
        try {
          await withSavepoint('sage_supplier_invoice_record', () =>
            insertNamingDuplicate(`${TAG}-dup`, insertBill(c, `${TAG}-dup-2`, fingerprint)));
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBeInstanceOf(Error);
      expect(isDuplicateFingerprintViolation(caught)).toBe(true);

      // THE POINT: without the savepoint this UPDATE raises 25P02, escapes to
      // failRun() and takes the whole run down. It must land.
      const marked = await c.query(
        `UPDATE sage_supplier_invoices SET migration_status = 'imported'
          WHERE id = $1 AND company_id = $2 RETURNING migration_status`,
        [staging, COMPANY],
      );
      expect(marked.rows[0].migration_status).toBe('imported');

      // And the record already imported by this run is still there.
      const kept = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-dup`],
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
      const fingerprint = computeFingerprint(null, `${TAG}-nosp`, 115);
      await insertBill(c, `${TAG}-nosp`, fingerprint)();
      await expect(insertBill(c, `${TAG}-nosp-2`, fingerprint)())
        .rejects.toMatchObject({ code: '23505' });

      await expect(c.query(
        `UPDATE sage_supplier_invoices SET migration_status = 'failed' WHERE company_id = $1`,
        [COMPANY],
      )).rejects.toMatchObject({ code: '25P02' });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('recognises the violation through the wrapper that replaces its message', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const fingerprint = computeFingerprint(null, `${TAG}-cause`, 115);
      await run(c, () => insertBill(c, `${TAG}-cause`, fingerprint)());

      await run(c, async () => {
        await expect(
          withSavepoint('sage_supplier_invoice_record', () =>
            insertNamingDuplicate(`${TAG}-cause`, insertBill(c, `${TAG}-cause-2`, fingerprint))),
        ).rejects.toMatchObject({
          message: expect.stringContaining('already has an invoice'),
          // The pg error stays reachable for a caller that branches on it.
          cause: expect.objectContaining({ code: '23505' }),
        });
      });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
