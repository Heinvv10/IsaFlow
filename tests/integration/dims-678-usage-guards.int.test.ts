/**
 * #678 review M6 / L4 / M2: the usage guards' SQL against real Postgres. One
 * reference in each table the cost-centre guard counts refuses the delete and
 * keeps the row; and a line written between the count and the DELETE is held
 * by the journal-line FK (migration 878), answered as the same refusal inside
 * its own savepoint, so the request transaction stays usable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { deleteCostCentre } from '@/modules/accounting/services/core/costCentreService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { bankLine, costCentre, dropBase, inRequest, journalLine, seedBase, tagHistory, type Base } from './dims-678.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
let b: Base;
let ob: Base;

beforeAll(async () => {
  b = await seedBase(pool, company, user);
  ob = await seedBase(pool, other, user);
}, 60000);
afterAll(async () => {
  try { await dropBase(pool, [company, other], [user]); } finally { await pool.end(); }
}, 60000);

type Plant = (cc: string) => Promise<unknown>;
const q = (text: string, values: unknown[]) => pool.query(text, values);
const PLANTS: [string, string, Plant][] = [
  ['journal line cost_center_id', 'journal line(s)', (cc) => journalLine(pool, b, 'cost_center_id', cc)],
  ['journal line cc1_id', 'journal line(s)', (cc) => journalLine(pool, b, 'cc1_id', cc)],
  ['journal line cc2_id', 'journal line(s)', (cc) => journalLine(pool, b, 'cc2_id', cc)],
  ['journal entry', 'journal entry(ies)', (cc) => q('UPDATE gl_journal_entries SET cost_center_id = $2 WHERE id = $1', [b.journal, cc])],
  ['employee', 'employee(s)', (cc) => q('UPDATE payroll_employees SET cost_centre_id = $2 WHERE id = $1', [b.employee, cc])],
  ['employee allocation', 'employee allocation(s)', (cc) => q(
    'INSERT INTO payroll_employee_cost_allocations(company_id, employee_id, cost_centre_id, percentage) VALUES($1, $2, $3, 100)',
    [company, b.employee, cc])],
  ['asset', 'asset(s)', (cc) => q(
    `INSERT INTO assets(company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, cost_centre_id)
     VALUES($1, $2, 'Van', '2026-01-01', 1000, 5, $3)`, [company, `A-${cc.slice(0, 6)}`, cc])],
  ['child', 'child cost centre(s)', (cc) => costCentre(pool, company, `KID-${cc.slice(0, 6)}`, 'cc2', cc)],
  ['supplier invoice', 'document(s)', (cc) => q('UPDATE supplier_invoices SET cost_center_id = $2 WHERE id = $1', [b.supplierInvoice, cc])],
  ['supplier invoice item', 'document(s)', (cc) => q(
    "INSERT INTO supplier_invoice_items(supplier_invoice_id, description, cost_center_id) VALUES($1, 'x', $2)", [b.supplierInvoice, cc])],
  ['supplier invoice item cc2', 'document(s)', (cc) => q(
    "INSERT INTO supplier_invoice_items(supplier_invoice_id, description, cc2_id) VALUES($1, 'x', $2)", [b.supplierInvoice, cc])],
  ['customer invoice item cc1', 'document(s)', (cc) => q(
    "INSERT INTO customer_invoice_items(invoice_id, description, unit_price, amount, cc1_id) VALUES($1, 'x', 1, 1, $2)",
    [b.customerInvoice, cc])],
  ['credit note', 'document(s)', (cc) => q(
    "INSERT INTO credit_notes(company_id, type, credit_date, created_by, cost_center_id) VALUES($1, 'customer', '2026-08-01', $2, $3)",
    [company, user, cc])],
  ['credit note cc2', 'document(s)', (cc) => q(
    "INSERT INTO credit_notes(company_id, type, credit_date, created_by, cc2_id) VALUES($1, 'customer', '2026-08-01', $2, $3)",
    [company, user, cc])],
  ['customer payment', 'document(s)', (cc) => q(
    "INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, created_by, cost_center_id) VALUES($1, $2, '2026-08-01', 1, $3, $4)",
    [company, b.customer, user, cc])],
  ['supplier payment', 'document(s)', (cc) => q(
    "INSERT INTO supplier_payments(company_id, supplier_id, payment_date, total_amount, created_by, cost_center_id) VALUES($1, $2, '2026-08-01', 1, $3, $4)",
    [company, b.supplier, user, cc])],
  ['purchase order', 'document(s)', (cc) => q(
    'INSERT INTO supplier_purchase_orders(company_id, order_number, supplier_id, cost_center_id) VALUES($1, $2, $3, $4)',
    [company, `PO-${cc.slice(0, 6)}`, b.supplier, cc])],
  ['expense claim line', 'document(s)', (cc) => q(
    "INSERT INTO expense_claim_lines(company_id, claim_id, line_date, cost_centre_id) VALUES($1, $2, '2026-08-01', $3)",
    [company, b.claim, cc])],
  ['bank line cc1', 'bank transaction(s)', (cc) => bankLine(pool, b, 'cc1_id', cc)],
  ['bank line cc2', 'bank transaction(s)', (cc) => bankLine(pool, b, 'cc2_id', cc)],
  ['coding rule', 'coding rule(s)', (cc) => q(
    'INSERT INTO supplier_coding_rules(company_id, supplier_id, default_cost_centre_id) VALUES($1, $2, $3)', [company, b.supplier, cc])],
  ['coding history', 'coding rule(s)', (cc) => q(
    'INSERT INTO supplier_coding_history(company_id, supplier_id, posted_by, cost_centre_id) VALUES($1, $2, $3, $4)',
    [company, b.supplier, user, cc])],
  ['customer default', 'customer/account default(s)', (cc) => q(
    'UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [b.customer, cc])],
  ['account default', 'customer/account default(s)', (cc) => q(
    'UPDATE gl_accounts SET default_cc2_id = $2 WHERE id = $1', [b.account, cc])],
  ['tag history', 'un-reversed tag batch line(s)', (cc) => tagHistory(pool, b, 'old_cc1_id', cc)],
];

describe('assertCostCentreUnused counts a reference in each table', () => {
  it.each(PLANTS)('%s refuses the delete', async (label, expected, plant) => {
    const cc = await costCentre(pool, company, `G-${PLANTS.findIndex((p) => p[0] === label)}`);
    await plant(cc);
    const err = await inRequest(pool, b, () => deleteCostCentre(company, cc)).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain(`1 ${expected}`);
    expect((await q('SELECT 1 FROM cost_centres WHERE id = $1', [cc])).rowCount).toBe(1);
    // Release the reference so the next row's counts start from nothing (defaults are reused rows).
    await q('UPDATE customers SET default_cc1_id = NULL WHERE company_id = $1', [company]);
    await q('UPDATE gl_accounts SET default_cc2_id = NULL WHERE company_id = $1', [company]);
    await q('UPDATE payroll_employees SET cost_centre_id = NULL WHERE company_id = $1', [company]);
    await q('UPDATE gl_journal_entries SET cost_center_id = NULL WHERE company_id = $1', [company]);
    await q('UPDATE supplier_invoices SET cost_center_id = NULL WHERE company_id = $1', [company]);
  });

  it('deletes a centre that only the payroll assignment history names (display-only text, not counted)', async () => {
    const cc = await costCentre(pool, company, 'G-HIST');
    await q("INSERT INTO payroll_employee_history(company_id, employee_id, field_name, old_value, new_value) VALUES($1, $2, 'cost_centre_id', NULL, $3)",
      [company, b.employee, cc]);
    await inRequest(pool, b, () => deleteCostCentre(company, cc));
    expect((await q('SELECT 1 FROM cost_centres WHERE id = $1', [cc])).rowCount).toBe(0);
    // The history row keeps its text: it was never a reference.
    expect((await q("SELECT new_value FROM payroll_employee_history WHERE company_id = $1 AND new_value = $2", [company, cc])).rowCount).toBe(1);
  });

  it('deletes a centre nothing references', async () => {
    const cc = await costCentre(pool, company, 'G-FREE');
    await inRequest(pool, b, () => deleteCostCentre(company, cc));
    expect((await q('SELECT 1 FROM cost_centres WHERE id = $1', [cc])).rowCount).toBe(0);
  });
});

describe('the journal and bank dimension FKs (migration 878)', () => {
  it.each([
    ['gl_journal_lines', 'cc1_id'], ['gl_journal_lines', 'cc2_id'], ['bank_transactions', 'cc1_id'], ['bank_transactions', 'cc2_id'],
  ] as const)('%s.%s held by another tenant: the FK refuses, the refusal survives, the transaction stays usable', async (table, col) => {
    const cc = await costCentre(pool, company, `X-${table.slice(0, 4)}-${col}`);
    // Invisible to the company-scoped count; only the FK sees it.
    if (table === 'gl_journal_lines') await journalLine(pool, ob, col, cc); else await bankLine(pool, ob, col, cc);
    const out = await inRequest(pool, b, async (c) => {
      const err = await deleteCostCentre(company, cc).catch((e: Error) => e);
      return { err, after: (await c.query('SELECT 1 AS ok')).rows[0].ok };
    });
    expect((out.err as Error).message).toBe('Cannot delete cost centre that is used by other records. Deactivate instead.');
    expect(out.after).toBe(1);
    expect((await q('SELECT 1 FROM cost_centres WHERE id = $1', [cc])).rowCount).toBe(1);
  });

  it('a journal line committed between the count and the DELETE is held, not left dangling', async () => {
    const cc = await costCentre(pool, company, 'X-RACE');
    const peer = await pool.connect();
    try {
      await peer.query('BEGIN');
      await peer.query(
        'INSERT INTO gl_journal_lines(company_id, journal_entry_id, gl_account_id, debit, credit, cc1_id) VALUES($1, $2, $3, 10, 0, $4)',
        [company, b.journal, b.account, cc]);
      // The count cannot see the peer's uncommitted line; the DELETE waits on its key-share lock.
      const del = inRequest(pool, b, () => deleteCostCentre(company, cc)).catch((e: Error) => e);
      for (let i = 0; i < 50; i++) {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM cost_centres%'");
        if (waiting.rowCount) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await peer.query('COMMIT');
      const err = await del;
      expect((err as Error).message).toMatch(/Cannot delete cost centre that is used by/);
    } finally { peer.release(); }
    const dangling = await q(
      'SELECT count(*)::int AS n FROM gl_journal_lines jl WHERE jl.cc1_id = $1 AND NOT EXISTS (SELECT 1 FROM cost_centres c WHERE c.id = jl.cc1_id)', [cc]);
    expect(dangling.rows[0].n).toBe(0);
  });
});
