/**
 * Migration 1022 (supplier_purchase_orders retired into purchase_orders + po_items): seeds for the legacy tables and a
 * runner for the migration file itself. The integration build has already applied 1022, so the legacy tables refuse writes:
 * a seed runs with their user triggers disabled inside its own transaction (the fixture's postgres is a superuser; suites in a
 * shard run one file at a time, so the DDL meets no other suite). Disposable databases only (the suite calls assertDisposable).
 */
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';

export const MIGRATION = readFileSync('scripts/migrations/sql/1022_retire_supplier_purchase_orders.sql', 'utf8');
const LEGACY = ['supplier_purchase_orders', 'supplier_purchase_order_items'] as const;
const ENABLE: Record<string, string> = { A: 'ENABLE ALWAYS TRIGGER', O: 'ENABLE TRIGGER', R: 'ENABLE REPLICA TRIGGER' };

/** Runs `fn` with the legacy tables' user triggers off (the pre-1022 state), committed. */
export async function asBeforeRetirement<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Each trigger goes back to the state it was in (never forced to ALWAYS, which would hide a migration that left it ENABLE).
    const states = (await c.query(`SELECT tgrelid::regclass::TEXT AS t, tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = ANY($1::regclass[]) AND NOT tgisinternal`, [[...LEGACY]])).rows as Array<{ t: string; tgname: string; tgenabled: string }>;
    for (const t of LEGACY) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    const out = await fn(c);
    for (const st of states) if (ENABLE[st.tgenabled]) await c.query(`ALTER TABLE ${st.t} ${ENABLE[st.tgenabled]} ${st.tgname}`);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export interface SpoLine {
  qty: number; price: number; discount?: number; taxRate?: number | null; lineTotal?: number; tax?: number | null;
  received?: number; invoiced?: number; item?: string | null; gl?: string | null; description?: string; id?: string;
}
export interface SpoSeed {
  co: string; number: string; supplier: string; status: string | null; lines: SpoLine[];
  notes?: string | null; internalNotes?: string | null; project?: string | null; costCentre?: string | null;
  reference?: string | null; orderDate?: string | null; deliveryDate?: string | null; createdBy?: string | null;
  createdAt?: string; headerTaxRate?: number | null;
}
export interface SeededSpo { id: string; items: string[]; subtotal: string; tax: string; total: string }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** One legacy PO; a line's total is the SPO app's (qty x price less the discount, 2 dp) unless given. */
export async function seedSpo(c: PoolClient, s: SpoSeed): Promise<SeededSpo> {
  const id = crypto.randomUUID();
  const lines = s.lines.map((l) => {
    const lineTotal = l.lineTotal ?? r2(l.qty * l.price * (1 - (l.discount ?? 0) / 100));
    return { ...l, lineTotal, tax: l.tax === undefined ? r2(lineTotal * (l.taxRate ?? 15) / 100) : l.tax };
  });
  const subtotal = r2(lines.reduce((a, l) => a + l.lineTotal, 0));
  const tax = r2(lines.reduce((a, l) => a + (l.tax ?? 0), 0));
  await c.query(
    `INSERT INTO supplier_purchase_orders (id, company_id, order_number, supplier_id, order_date, delivery_date, subtotal, tax_amount,
       total_amount, status, reference, notes, internal_notes, project_id, cost_center_id, created_by, created_at, updated_at, tax_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '2026-05-02T09:00:00Z', $18)`,
    [id, s.co, s.number, s.supplier, s.orderDate === undefined ? '2026-05-01' : s.orderDate, s.deliveryDate ?? null, subtotal, tax,
      r2(subtotal + tax), s.status, s.reference ?? `REF-${s.number}`, s.notes ?? null, s.internalNotes ?? null, s.project ?? null,
      s.costCentre ?? null, s.createdBy === undefined ? crypto.randomUUID() : s.createdBy, s.createdAt ?? '2026-05-01T08:00:00Z',
      s.headerTaxRate === undefined ? 15 : s.headerTaxRate]);
  const items: string[] = [];
  for (const [i, l] of lines.entries()) {
    const item = l.id ?? crypto.randomUUID();
    await c.query(
      `INSERT INTO supplier_purchase_order_items (id, purchase_order_id, description, quantity, unit_price, discount_percent, tax_rate,
         tax_amount, line_total, item_id, gl_account_id, qty_received, qty_invoiced, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [item, id, l.description ?? `Line ${i}`, l.qty, l.price, l.discount ?? 0, l.taxRate === undefined ? 15 : l.taxRate, l.tax, l.lineTotal, l.item ?? null,
        l.gl ?? null, l.received ?? 0, l.invoiced ?? 0, `2026-05-01T08:00:0${i}Z`]);
    items.push(item);
  }
  return { id, items, subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: r2(subtotal + tax).toFixed(2) };
}

/** Runs the migration file in one transaction, as the runner does; returns the NOTICE / WARNING texts it raised. */
export async function runMigration(pool: Pool, asRole?: string): Promise<string[]> {
  const c = await pool.connect();
  const notices: string[] = [];
  const listen = (n: { message?: string }) => { notices.push(String(n.message)); };
  c.on('notice', listen);
  try {
    await c.query('BEGIN');
    if (asRole) await c.query(`SET LOCAL ROLE ${asRole}`);
    await c.query(MIGRATION);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.removeListener('notice', listen);
    c.release();
  }
  return notices;
}

/** Every canonical row a company has, as text: what a re-run must leave exactly as it was. */
export async function canonicalSnapshot(pool: Pool, companies: readonly string[]) {
  const heads = (await pool.query(
    `SELECT to_jsonb(p) - 'updated_at' AS r, p.updated_at FROM purchase_orders p WHERE p.company_id = ANY($1::UUID[]) ORDER BY p.id`,
    [[...companies]])).rows;
  const lines = (await pool.query(
    `SELECT to_jsonb(i) AS r FROM po_items i JOIN purchase_orders p ON p.id = i.purchase_order_id
      WHERE p.company_id = ANY($1::UUID[]) ORDER BY i.id`, [[...companies]])).rows;
  const links = (await pool.query(
    `SELECT to_jsonb(l) AS r FROM purchase_order_bill_links l WHERE l.company_id = ANY($1::UUID[]) ORDER BY l.id`, [[...companies]])).rows;
  const counters = (await pool.query(
    `SELECT company_id, prefix, next_number FROM company_document_numbers
      WHERE company_id = ANY($1::UUID[]) AND document_type = 'purchase_order' ORDER BY company_id`, [[...companies]])).rows;
  return JSON.stringify({ heads, lines, links, counters });
}

/** The po_items of the companies' purchase orders, then their items (call before dropBillFixture). */
export async function dropCanonical(pool: Pool, companies: readonly string[]): Promise<void> {
  await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = ANY($1::UUID[]))', [[...companies]]);
  await pool.query('DELETE FROM items WHERE company_id = ANY($1::UUID[])', [[...companies]]);
}

/** The legacy rows of the companies, so the fixture can be dropped. */
export async function dropLegacy(pool: Pool, companies: readonly string[]): Promise<void> {
  await asBeforeRetirement(pool, async (c) => {
    await c.query(`DELETE FROM supplier_purchase_order_items WHERE purchase_order_id IN
                     (SELECT id FROM supplier_purchase_orders WHERE company_id = ANY($1::UUID[]))`, [[...companies]]);
    await c.query('DELETE FROM supplier_purchase_orders WHERE company_id = ANY($1::UUID[])', [[...companies]]);
  });
}
