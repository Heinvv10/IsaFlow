/**
 * lockSupplierInvoiceForUpdate — the serialisation guarantee, tested deterministically.
 *
 * `approveSupplierInvoice` reads `supplier_invoices.status`, refuses on the
 * wrong status, posts the Expense/VAT/AP journal, and only THEN writes
 * `status = 'approved'`. Without a row lock two concurrent requests both read
 * 'draft', both post a journal, and the second UPDATE overwrites the first's
 * `gl_journal_entry_id` — one bill, two journals, the payable credited twice,
 * and one journal orphaned where no reversal can reach it.
 *
 * `bulk_approve_supplier_invoices` is what makes that reachable rather than
 * theoretical: it holds one request transaction open across up to 100 invoices,
 * so the window a concurrent single approve has to lose is measured in seconds.
 *
 * An end-to-end "fire two approvals at once" test cannot prove the remedy — the
 * interleaving is timing-dependent and passes just as happily with the lock
 * removed. What IS deterministic is the lock's own contract, which is what the
 * service depends on:
 *
 *   - a second transaction asking for the same row BLOCKS while the first holds it
 *   - it surfaces as SupplierInvoiceLockTimeoutError rather than hanging forever
 *   - a DIFFERENT row is never blocked (the lock is per-invoice, not per-table)
 *   - it refuses to run outside a request transaction, where FOR UPDATE would
 *     release immediately and serialise nothing
 *
 * Mirrors creditNoteLock.test.ts deliberately — same defect class, same remedy,
 * so a reader who knows one test knows the other.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  lockSupplierInvoiceForUpdate,
  SupplierInvoiceLockTimeoutError,
} from '@/modules/accounting/services/ap/supplierInvoiceLock';

const COMPANY = '00000000-0000-0000-0000-000000000ab1';
const OTHER_COMPANY = '00000000-0000-0000-0000-000000000ab2';
const USER = '00000000-0000-0000-e2e0-000000000001';
const TAG = `SILOCK-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let invoiceA: string;
let invoiceB: string;

async function makeInvoice(number: string): Promise<string> {
  const rows = await sql`
    INSERT INTO supplier_invoices
      (company_id, supplier_id, invoice_number, invoice_date, subtotal,
       tax_rate, tax_amount, total_amount, status, created_by)
    VALUES
      (${COMPANY}::UUID, ${supplier}::UUID, ${number}, '2026-06-30', 100,
       15, 15, 115, 'draft', ${USER}::UUID)
    RETURNING id` as { id: string }[];
  return rows[0]!.id;
}

/** Run fn on its own client inside a transaction that the caller closes. */
async function begin(): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  return c;
}
function on<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  // suppliers.company_id FKs to companies.
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${COMPANY}::UUID, 'SI Lock Test', 'SILOCK-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  supplier = (await sql`
    INSERT INTO suppliers (name, company_id) VALUES (${'LOCK ' + TAG}, ${COMPANY}::UUID)
    RETURNING id` as { id: string }[])[0]!.id;
  invoiceA = await makeInvoice(`${TAG}-A`);
  invoiceB = await makeInvoice(`${TAG}-B`);
});

afterAll(async () => {
  await sql`DELETE FROM supplier_invoices WHERE supplier_id = ${supplier}::UUID`;
  await sql`DELETE FROM suppliers WHERE id = ${supplier}::UUID`;
  await pool.end();
});

describe('lockSupplierInvoiceForUpdate', () => {
  /**
   * Outside a request transaction every statement is its own implicit
   * transaction, so FOR UPDATE releases the instant the SELECT returns and the
   * caller believes it is serialised when it is not. A loud failure beats a
   * lock that silently does nothing.
   */
  it('refuses to run outside a request transaction', async () => {
    await expect(lockSupplierInvoiceForUpdate(COMPANY, invoiceA))
      .rejects.toThrow(/requires a request transaction/);
  });

  /** Company-scoped: another tenant's id is indistinguishable from a miss. */
  it('returns null for an invoice belonging to another tenant', async () => {
    const c = await begin();
    try {
      expect(await on(c, () => lockSupplierInvoiceForUpdate(OTHER_COMPANY, invoiceA))).toBeNull();
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('returns null for an invoice that does not exist', async () => {
    const c = await begin();
    try {
      expect(await on(c, () => lockSupplierInvoiceForUpdate(
        COMPANY, '00000000-0000-4000-8000-000000000999',
      ))).toBeNull();
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  /** The property the whole fix rests on. */
  it('blocks a second transaction on the SAME invoice until the first commits', async () => {
    const a = await begin();
    const b = await begin();
    try {
      expect(await on(a, () => lockSupplierInvoiceForUpdate(COMPANY, invoiceA))).not.toBeNull();

      let settled = false;
      const contender = on(b, () => lockSupplierInvoiceForUpdate(COMPANY, invoiceA))
        .then((r) => { settled = true; return r; });

      // Give the contender a real chance to complete. It must NOT: A holds the row.
      await new Promise((r) => setTimeout(r, 700));
      expect(settled, 'second transaction acquired the lock while the first held it').toBe(false);

      await a.query('COMMIT');
      expect(await contender).not.toBeNull();
    } finally {
      await b.query('ROLLBACK').catch(() => {});
      a.release(); b.release();
    }
  });

  /**
   * A bulk approve locks up to 100 rows in one transaction. If the lock were
   * per-table rather than per-row, one batch would freeze every other approval
   * on the tenant for its whole duration.
   */
  it('does not block a DIFFERENT invoice — the lock is per row, not per table', async () => {
    const a = await begin();
    const b = await begin();
    try {
      await on(a, () => lockSupplierInvoiceForUpdate(COMPANY, invoiceA));
      const other = await Promise.race([
        on(b, () => lockSupplierInvoiceForUpdate(COMPANY, invoiceB)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('blocked on an unrelated invoice')), 2000)),
      ]);
      expect(other).not.toBeNull();
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
      a.release(); b.release();
    }
  });

  /**
   * The typed error is what the bulk runner matches on by CODE to turn a busy
   * row into a skipped line rather than a failed batch. If this surfaced as a
   * bare 55P03 the runner would treat it as fatal and roll back the other 99.
   */
  it('surfaces a held row as SupplierInvoiceLockTimeoutError instead of hanging', async () => {
    const a = await begin();
    const b = await begin();
    try {
      await on(a, () => lockSupplierInvoiceForUpdate(COMPANY, invoiceA));
      const err = await on(b, () => lockSupplierInvoiceForUpdate(COMPANY, invoiceA))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SupplierInvoiceLockTimeoutError);
      expect((err as SupplierInvoiceLockTimeoutError).code).toBe('SUPPLIER_INVOICE_LOCK_TIMEOUT');
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK').catch(() => {});
      a.release(); b.release();
    }
  }, 20000);

  /**
   * `SET LOCAL lock_timeout` lasts to the end of the TRANSACTION, not the
   * statement. Left set, the 5s budget would silently govern every lock taken
   * afterwards in the same request — in a bulk approve that is the other 99
   * invoices plus the locks the journal posting itself takes, each failing with
   * a bare 55P03 that nothing maps to the typed error.
   */
  it('restores the default lock_timeout on the success path', async () => {
    const c = await begin();
    try {
      await on(c, () => lockSupplierInvoiceForUpdate(COMPANY, invoiceA));
      const rows = (await c.query('SHOW lock_timeout')).rows as { lock_timeout: string }[];
      expect(rows[0]!.lock_timeout).toBe('0');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
