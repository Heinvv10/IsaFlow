/**
 * K-090 — a Sage import run whose statement fails reports its own cause, on
 * real PostgreSQL. `failRun` used to run on the transaction the failure had
 * aborted, so the operator saw 25P02 instead of the real error. The run row
 * is marked inside the request transaction, which withAuth rolls back with
 * the 500; it is observable here, on the same connection, before ROLLBACK.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { importSupplierInvoices } from '@/modules/accounting/services/core/sageImportService';
import { startRun, withRunRecovery } from '@/modules/accounting/services/core/sageMigrationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyA = randomUUID();
const companyB = randomUUID();
const user = randomUUID();
const SUPPLIER_NAME = 'K090 Supplier';
const { drive, driveExpectingFailure, seedStaging } = sageImportHarness(pool, user);

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'K090 company A'], [companyB, 'K090 company B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const id of [companyA, companyB]) {
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [id, user]);
    await pool.query('INSERT INTO suppliers(company_id,name,payment_terms) VALUES($1,$2,30)', [id, SUPPLIER_NAME]);
  }
});

afterAll(async () => {
  try {
    for (const id of [companyA, companyB]) {
      await pool.query('DELETE FROM sage_supplier_invoices WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM suppliers WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM gl_migration_runs WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('K-090: a failed run reports its own cause and is recorded', () => {
  it('surfaces the original error, not 25P02, and marks the run failed with it', async () => {
    // A body whose statement fails on the request transaction. Before this
    // fix the caller saw "current transaction is aborted" from failRun's own
    // UPDATE and the run stayed 'running'. The trigger is a plain 42703 so
    // the test outlives R-101 (the customer importer's own schema mismatch).
    const outcome = await driveExpectingFailure(companyB, async () => {
      const runId = await startRun('invoice_import', user, companyB);
      return withRunRecovery(runId, companyB, () => sql`SELECT no_such_column FROM sage_supplier_invoices`);
    });

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toMatch(/does not exist/);
    expect(outcome.error.message).not.toMatch(/current transaction is aborted/);
    expect(outcome.status).toBe('failed');
    expect(outcome.errorMessage).toMatch(/does not exist/);
  });

  it('does not mark a run of another company failed', async () => {
    // A's run, marked under B's scope: A's row must stay 'running'.
    const outcome = await driveExpectingFailure(companyA, async () => {
      const runOfA = await startRun('invoice_import', user, companyA);
      return withRunRecovery(runOfA, companyB, () => sql`SELECT no_such_column FROM sage_supplier_invoices`);
    });
    expect(outcome.error.message).toMatch(/does not exist/);
    expect(outcome.status).toBe('running');
  });

  it('recovers the transaction after a row-level failure and marks that row failed', async () => {
    // invoice_date is nullable in staging and NOT NULL on supplier_invoices,
    // so this row raises 23502 inside the per-row INSERT. Before the per-row
    // savepoint, the markFailed UPDATE that follows ran on the transaction
    // that INSERT had just aborted.
    const tag = `K090R-${randomUUID().slice(0, 8)}`;
    const badId = (await pool.query<{ id: string }>(
      `INSERT INTO sage_supplier_invoices
         (company_id, sage_id, invoice_number, supplier_name, invoice_date, total_amount, migration_status)
       VALUES ($1,$2,$3,$4,NULL,900,'pending') RETURNING id`,
      [companyA, `${tag}-SAGE`, `${tag}-INV`, SUPPLIER_NAME],
    )).rows[0]!.id;
    const goodId = await seedStaging(companyA, {
      sageId: `${tag}-OK`, invoiceNumber: `${tag}-OKINV`, supplierName: SUPPLIER_NAME, total: 1150,
    });

    // The run must COMPLETE — the whole point is that one bad row no longer
    // takes the transaction, and therefore the request, down with it.
    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.status).toBe('partial');
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);

    const rows = (await pool.query(
      'SELECT id, migration_status FROM sage_supplier_invoices WHERE id = ANY($1)',
      [[badId, goodId]],
    )).rows;
    expect(rows.find(r => r.id === badId)!.migration_status).toBe('failed');
    expect(rows.find(r => r.id === goodId)!.migration_status).toBe('imported');
  });
});
