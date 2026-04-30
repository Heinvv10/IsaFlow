import { withTransactionPg } from '../_pg';
import type { TaggedSql } from './types';

/**
 * Pre-flight guard for the destructive --reset path. Refuses to delete
 * unless ALL of:
 *   1. QA_DESTRUCTIVE_OK=1 is set in the environment
 *   2. The company exists in the DB
 *   3. The company name starts with "IsaDemo" (matches the QA fixture
 *      naming convention from provision-isademo2.ts)
 *
 * If any check fails, exits the process with a clear error message rather
 * than proceeding to delete. This prevents a misconfigured COMPANY_ID env
 * var from wiping a real tenant.
 */
export async function assertResetIsSafe(sql: TaggedSql, companyId: string): Promise<void> {
  if (process.env.QA_DESTRUCTIVE_OK !== '1') {
    console.error('[reset] REFUSED: --reset deletes tenant data. Set QA_DESTRUCTIVE_OK=1 to confirm.');
    process.exit(1);
  }
  const rows = await sql`SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1` as Array<{ name: string }>;
  if (rows.length === 0) {
    console.error(`[reset] REFUSED: company ${companyId} does not exist.`);
    process.exit(1);
  }
  const name = rows[0]!.name;
  if (!/^IsaDemo/i.test(name)) {
    console.error(`[reset] REFUSED: company "${name}" does not match the IsaDemo* QA-fixture naming. Wrong tenant?`);
    process.exit(1);
  }
  console.log(`[reset] guard OK: target company "${name}" matches QA-fixture naming`);
}

/**
 * Wipe QA records for the given company atomically so a mid-flight failure
 * can't leave the FK graph half-deleted. Order matches referential
 * dependencies: dependent rows first, parent tables last.
 *
 * Uses withTransactionPg so all DELETEs run on a single pg client (real
 * BEGIN/COMMIT). Bare `sql\`BEGIN\`` over the shared template would check
 * out a fresh connection per statement and the transaction would be a no-op.
 */
export async function resetQaRecords(sql: TaggedSql, companyId: string): Promise<void> {
  await assertResetIsSafe(sql, companyId);
  console.log('[reset] Wiping QA records...');
  await withTransactionPg(async (tx) => {
    await tx`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${companyId}::uuid)`;
    await tx`DELETE FROM customer_payments            WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM customer_invoice_items       WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${companyId}::uuid)`;
    await tx`DELETE FROM customer_invoices            WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM supplier_invoice_items       WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${companyId}::uuid)`;
    await tx`DELETE FROM supplier_invoices            WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM time_entries                 WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM practice_jobs                WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM practice_client_rate_overrides WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM practice_clients             WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM practice_work_items          WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM practice_job_categories      WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM practice_staff_rates         WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM bank_transactions            WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM bank_feed_sync_logs          WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM bank_feed_connections        WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM bank_accounts                WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM customers                    WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM suppliers                    WHERE company_id = ${companyId}::uuid`;
    await tx`DELETE FROM gl_accounts                  WHERE company_id = ${companyId}::uuid`;
  });
  console.log('[reset] Done.');
}
