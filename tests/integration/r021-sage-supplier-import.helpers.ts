/**
 * Shared harness for the Sage supplier-invoice importer integration tests
 * (R-021 / K-088 / K-090). Every call drives the service inside an `als`
 * request transaction, exactly as `withAuth` does.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

export function sageImportHarness(pool: Pool, user: string) {
  function run<T>(c: PoolClient, companyId: string, fn: () => Promise<T>): Promise<T> {
    return als.run({ client: c, userId: user, companyId, claims: {} } as never, fn);
  }

  /** Run `fn` in a committed request transaction, as withAuth does on success. */
  async function drive<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const out = await run(c, companyId, fn);
      await c.query('COMMIT');
      return out;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  /**
   * Drive a call that is expected to throw, and read the run record back on the
   * SAME connection before rolling back — which is the only place it is
   * observable, since withAuth rolls the request transaction back on a 500.
   * The read is itself the assertion that the transaction survived the failure.
   */
  async function driveExpectingFailure(
    companyId: string,
    fn: () => Promise<unknown>,
  ): Promise<{ error: Error; status: string; errorMessage: string }> {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      let error: unknown;
      await run(c, companyId, fn).catch((e: unknown) => { error = e; });
      const runs = await c.query<{ status: string; error_message: string }>(
        'SELECT status, error_message FROM gl_migration_runs WHERE company_id=$1 ORDER BY started_at DESC LIMIT 1',
        [companyId],
      );
      return {
        error: error as Error,
        status: runs.rows[0]?.status ?? '',
        errorMessage: runs.rows[0]?.error_message ?? '',
      };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  /** pg returns DATE as a Date at local midnight; compare the calendar date. */
  function fmt(d: unknown): string {
    if (!(d instanceof Date)) return String(d);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function seedStaging(
    companyId: string,
    opts: { sageId: string | null; invoiceNumber: string; supplierName: string; total: number },
  ): Promise<string> {
    const rows = await pool.query<{ id: string }>(
      `INSERT INTO sage_supplier_invoices
         (company_id, sage_id, invoice_number, supplier_name, invoice_date, total_amount, migration_status)
       VALUES ($1,$2,$3,$4,'2026-06-30',$5,'pending') RETURNING id`,
      [companyId, opts.sageId, opts.invoiceNumber, opts.supplierName, opts.total],
    );
    return rows.rows[0]!.id;
  }

  return { drive, driveExpectingFailure, seedStaging, fmt };
}
