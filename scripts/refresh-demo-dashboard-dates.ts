/**
 * Refresh ISAFlow Demo dates used by dashboard action widgets.
 *
 * Dry-run:
 *   bun scripts/refresh-demo-dashboard-dates.ts
 *
 * Apply:
 *   bun scripts/refresh-demo-dashboard-dates.ts --apply
 *
 * The script only targets the default ISAFlow Demo company. It keeps amounts,
 * customers, suppliers and invoice numbers intact, but moves open invoice due
 * dates into a realistic mix of current, due-soon and recently overdue items.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSql, closeSql } from './_pg';

const COMPANY_ID = process.env.DEMO_COMPANY_ID ?? '00000000-0000-0000-0000-000000000001';
const APPLY = process.argv.includes('--apply');

function loadEnvFile(): void {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (!key || process.env[key]) continue;
    process.env[key] = (rawValue ?? '').trim().replace(/^["']|["']$/g, '');
  }
}

loadEnvFile();

const DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL is required.');
  process.exit(1);
}

const sql = createSql(DATABASE_URL);

type SummaryRow = {
  label: string;
  rows: number;
  earliest_due: string | null;
  latest_due: string | null;
  max_days_overdue: number;
};

async function summarize(label: string, table: 'customer_invoices' | 'supplier_invoices', statuses: string[]): Promise<SummaryRow> {
  const rows = await sql.query<SummaryRow>(
    `
      SELECT
        $1::text AS label,
        COUNT(*)::int AS rows,
        MIN(due_date)::text AS earliest_due,
        MAX(due_date)::text AS latest_due,
        COALESCE(MAX(GREATEST(0, CURRENT_DATE - due_date)), 0)::int AS max_days_overdue
      FROM ${table}
      WHERE company_id = $2::uuid
        AND status = ANY($3::text[])
        AND due_date IS NOT NULL
    `,
    [label, COMPANY_ID, statuses],
  );
  return rows[0]!;
}

function printSummary(title: string, rows: SummaryRow[]): void {
  console.log(`\n${title}`);
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(18)} rows=${String(r.rows).padStart(4)} ` +
      `due=${r.earliest_due ?? '-'}..${r.latest_due ?? '-'} ` +
      `max_overdue=${r.max_days_overdue}d`,
    );
  }
}

async function refreshCustomerInvoices(): Promise<number> {
  const rows = await sql.query<{ count: number }>(
    `
      WITH ranked AS (
        SELECT
          id,
          status,
          ROW_NUMBER() OVER (ORDER BY COALESCE(invoice_number, ''), id) AS rn
        FROM customer_invoices
        WHERE company_id = $1::uuid
          AND status IN ('draft', 'approved', 'sent', 'partially_paid', 'overdue')
          AND deleted_at IS NULL
      ),
      dated AS (
        SELECT
          id,
          CASE
            WHEN status = 'draft' THEN CURRENT_DATE + 32
            WHEN status = 'overdue' THEN CURRENT_DATE - (7 + (rn % 45))::int
            WHEN rn % 10 IN (1, 2, 3) THEN CURRENT_DATE - (ARRAY[7, 18, 35])[((rn % 3) + 1)::int]
            ELSE CURRENT_DATE + (3 + (rn % 21))::int
          END AS refreshed_due_date
        FROM ranked
      )
      UPDATE customer_invoices ci
      SET
        due_date = dated.refreshed_due_date,
        invoice_date = dated.refreshed_due_date - 30,
        updated_at = NOW()
      FROM dated
      WHERE ci.id = dated.id
      RETURNING 1 AS count
    `,
    [COMPANY_ID],
  );
  return rows.length;
}

async function refreshSupplierInvoices(): Promise<number> {
  const rows = await sql.query<{ count: number }>(
    `
      WITH ranked AS (
        SELECT
          id,
          status,
          ROW_NUMBER() OVER (ORDER BY COALESCE(invoice_number, ''), id) AS rn
        FROM supplier_invoices
        WHERE company_id = $1::uuid
          AND status IN ('draft', 'approved', 'pending', 'partially_paid')
      ),
      dated AS (
        SELECT
          id,
          CASE
            WHEN status = 'draft' THEN CURRENT_DATE + 28
            WHEN rn % 8 IN (1, 2) THEN CURRENT_DATE - (ARRAY[3, 12])[((rn % 2) + 1)::int]
            ELSE CURRENT_DATE + (1 + (rn % 14))::int
          END AS refreshed_due_date
        FROM ranked
      )
      UPDATE supplier_invoices si
      SET
        due_date = dated.refreshed_due_date,
        invoice_date = dated.refreshed_due_date - 30,
        updated_at = NOW()
      FROM dated
      WHERE si.id = dated.id
      RETURNING 1 AS count
    `,
    [COMPANY_ID],
  );
  return rows.length;
}

async function refreshBankTransactions(): Promise<number> {
  const rows = await sql.query<{ count: number }>(
    `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (ORDER BY transaction_date DESC, id) AS rn
        FROM bank_transactions
        WHERE company_id = $1::uuid
          AND status IN ('imported', 'matched')
      )
      UPDATE bank_transactions bt
      SET transaction_date = CURRENT_DATE - ((ranked.rn - 1) % 21)::int
      FROM ranked
      WHERE bt.id = ranked.id
      RETURNING 1 AS count
    `,
    [COMPANY_ID],
  );
  return rows.length;
}

async function main(): Promise<void> {
  console.log(APPLY ? 'APPLY mode' : 'DRY-RUN mode (pass --apply to commit)');
  console.log(`Target company: ${COMPANY_ID}`);

  const before = await Promise.all([
    summarize('customer open', 'customer_invoices', ['draft', 'approved', 'sent', 'partially_paid', 'overdue']),
    summarize('supplier open', 'supplier_invoices', ['draft', 'approved', 'pending', 'partially_paid']),
  ]);
  printSummary('Before', before);

  if (!APPLY) {
    console.log('\nNo changes made.');
    return;
  }

  const customerCount = await refreshCustomerInvoices();
  const supplierCount = await refreshSupplierInvoices();
  const bankCount = await refreshBankTransactions();
  console.log(`\nUpdated customer invoices: ${customerCount}`);
  console.log(`Updated supplier invoices: ${supplierCount}`);
  console.log(`Updated bank transactions: ${bankCount}`);

  const after = await Promise.all([
    summarize('customer open', 'customer_invoices', ['draft', 'approved', 'sent', 'partially_paid', 'overdue']),
    summarize('supplier open', 'supplier_invoices', ['draft', 'approved', 'pending', 'partially_paid']),
  ]);
  printSummary('After', after);
}

main()
  .catch((err: unknown) => {
    console.error('Refresh failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSql();
  });
