/**
 * The AP take-on import (`importAPInvoices`, migrationApService.ts) matches and accepts LIVE suppliers only (review of b4741393, M2 /
 * L3): a merged-away (soft-deleted) supplier is not a candidate, so
 *   - a row whose supplier name is shared by a merged-away supplier and a live one lands on the live one;
 *   - the wizard's manual override naming a deleted supplier is refused as "not found" for this company, and nothing is written.
 * Driven like k015-ap-migration-balance-due-column: the service inside one transaction that is rolled back. Fixture route:
 * isaflow_schema_fixture (or any disposable database with the schema).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const LIVE = randomUUID();
const GONE = randomUUID();
const TAG = `APLIVE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const NAME = `Shared Name ${TAG}`;
let pool: Pool;
let sessionId: string;

const run = <T>(c: PoolClient, fn: () => Promise<T>) => als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
const bill = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: `${TAG}-${randomUUID().slice(0, 6)}`, supplierName: NAME, invoiceDate: '2026-06-30', dueDate: '2026-07-30',
  subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 40, ...over,
});

describeIfDb('the AP take-on import and a merged-away supplier', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await sql`INSERT INTO companies (id, name, registration_number, created_at) VALUES (${COMPANY}::UUID, ${`APLIVE ${TAG}`}, ${TAG}, NOW())`;
    // The merged-away one first, so a name match that ignored deleted_at would meet it before the live one.
    await sql`INSERT INTO suppliers (id, name, company_id, deleted_at, created_at) VALUES (${GONE}::UUID, ${NAME}, ${COMPANY}::UUID, NOW(), NOW() - interval '1 day')`;
    await sql`INSERT INTO suppliers (id, name, company_id) VALUES (${LIVE}::UUID, ${NAME}, ${COMPANY}::UUID)`;
    const acct = (code: string, name: string, type: string, subtype: string, normal: string) => sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)`;
    await acct('6000', 'APLIVE Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'APLIVE AP', 'liability', 'payable', 'credit');
    await acct('2200', 'APLIVE VAT Input', 'asset', 'vat_input', 'debit');
    await acct('3100', 'APLIVE Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    clearSystemAccountCache();
    sessionId = ((await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by, steps_completed, errors)
      VALUES (${COMPANY}::UUID, 'sage', ${USER}::UUID, '{"coa": true, "suppliers": true}'::JSONB, '[]'::JSONB) RETURNING id`) as { id: string }[])[0]!.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
      for (const t of ['supplier_invoices', 'gl_journal_lines', 'gl_journal_entries', 'migration_sessions', 'suppliers']) {
        await sql`DELETE FROM ${sql.unsafe(t)} WHERE company_id = ${COMPANY}::UUID`;
      }
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
      await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    } finally { await pool.end(); }
  }, 60_000);

  it('a name shared with a merged-away supplier: the row lands on the live supplier', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const row = bill();
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [row], USER));
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      const placed = (await c.query('SELECT supplier_id::text AS s FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
        [COMPANY, row.invoiceNumber])).rows;
      expect(placed).toEqual([{ s: LIVE }]);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('an override naming the merged-away supplier is refused as not found; nothing is written', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const row = bill({ supplierId: GONE });
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [row], USER));
      expect(result.imported).toBe(0);
      expect(result.errors).toEqual([expect.objectContaining({ field: 'supplierId', message: `Supplier not found for this company: ${GONE}` })]);
      expect((await c.query('SELECT count(*)::int AS n FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
        [COMPANY, row.invoiceNumber])).rows[0].n).toBe(0);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
