/**
 * Census, counts and the wipe itself. Every statement is built from WIPE_STEPS
 * (wipePlan.ts) with the company id bound as $1, so the dry-run count and the
 * DELETE of a step can never disagree.
 */

import type { Tx } from './db';
import {
  BALANCE_CACHE_STEP, CASCADE_WITH, INVOICE_PAYMENT_REQUEST_TABLES, QA_MAILBOX_NAME, WIPE_STEPS, countSql, crossTenantSql, deleteSql, invoiceRequestWhere, isKept,
} from './wipePlan';

export interface TableCount { table: string; n: number }

async function companyTables(tx: Tx): Promise<string[]> {
  const rows = await tx.query<{ t: string }>(`
    SELECT c.table_name AS t FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'company_id' ORDER BY 1`);
  return rows.map((r) => r.t);
}

async function demoRows(tx: Tx, table: string, companyId: string): Promise<number> {
  const [r] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1::uuid`, [companyId]);
  return r?.n ?? 0;
}

/** Tables with Demo rows that are neither wiped nor kept: the run must refuse (a new migration added one). */
export async function censusUnclassified(tx: Tx, companyId: string): Promise<TableCount[]> {
  const wiped = new Set(WIPE_STEPS.map((s) => s.table));
  const out: TableCount[] = [];
  for (const table of await companyTables(tx)) {
    if (wiped.has(table) || isKept(table)) continue;
    const n = await demoRows(tx, table, companyId);
    if (n > 0) out.push({ table, n });
  }
  return out;
}

/** WIPE_STEPS tables the database no longer has (a migration dropped one): the plan is stale. */
export async function missingWipeTables(tx: Tx): Promise<string[]> {
  const rows = await tx.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`);
  const have = new Set(rows.map((r) => r.t));
  return WIPE_STEPS.map((s) => s.table).filter((t) => !have.has(t));
}

/** Child rows that name a Demo parent AND another company's parent (corrupt data): the run refuses while any exist. */
export async function crossTenantChildren(tx: Tx, companyId: string): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (const step of WIPE_STEPS) {
    const q = crossTenantSql(step);
    if (!q) continue;
    const [r] = await tx.query<{ n: number }>(q, [companyId]);
    if ((r?.n ?? 0) > 0) out.push({ table: step.table, n: r!.n });
  }
  return out;
}

async function cascadeCounts(tx: Tx, companyId: string): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (const [table, col, parent] of CASCADE_WITH) {
    const [r] = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1::uuid AND ${col} IN (SELECT id FROM ${parent} WHERE company_id = $1::uuid)`, [companyId]);
    out.push({ table: `${table} (cascades with ${parent})`, n: r?.n ?? 0 });
  }
  return out;
}

export async function countWipe(tx: Tx, companyId: string): Promise<TableCount[]> {
  const out: TableCount[] = await cascadeCounts(tx, companyId);
  for (const table of INVOICE_PAYMENT_REQUEST_TABLES) {
    const [r] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${invoiceRequestWhere()}`, [companyId]);
    out.push({ table: `${table} (invoice payment requests)`, n: r?.n ?? 0 });
  }
  for (const step of [...WIPE_STEPS, BALANCE_CACHE_STEP]) {
    const [r] = await tx.query<{ n: number }>(countSql(step), [companyId]);
    out.push({ table: step.table, n: r?.n ?? 0 });
  }
  const [mb] = await tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM imap_mirror_connections WHERE company_id = $1::uuid AND display_name ILIKE $2', [companyId, QA_MAILBOX_NAME]);
  out.push({ table: 'imap_mirror_connections (QA mailbox)', n: mb?.n ?? 0 });
  return out;
}

/** Kept tables holding Demo rows, with counts (the dry-run's "kept" report, post-check R2 and N6). */
export async function keptReport(tx: Tx, companyId: string): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (const table of await companyTables(tx)) {
    if (!isKept(table)) continue;
    const n = await demoRows(tx, table, companyId);
    if (n > 0) out.push({ table, n });
  }
  return out;
}

/** Intercompany rows naming a Demo journal: not handled, so the run refuses while any exist. */
export async function intercompanyCount(tx: Tx, companyId: string): Promise<number> {
  const [r] = await tx.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM intercompany_transactions
    WHERE source_journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1::uuid)
       OR target_journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1::uuid)`, [companyId]);
  return r?.n ?? 0;
}

export async function runWipe(tx: Tx, companyId: string): Promise<TableCount[]> {
  // Kept billing rows point at Demo invoices through (company_id, customer_invoice_id) with ON DELETE
  // SET NULL; company_id is NOT NULL, so the cascade would fail. A customer_invoice request cannot lose its
  // invoice (CHECK), so it goes with the invoice; any other purpose is unlinked.
  const out: TableCount[] = await cascadeCounts(tx, companyId);
  for (const table of INVOICE_PAYMENT_REQUEST_TABLES) {
    const res = await tx.client.query(`DELETE FROM ${table} WHERE ${invoiceRequestWhere()}`, [companyId]);
    out.push({ table: `${table} (invoice payment requests)`, n: res.rowCount ?? 0 });
    await tx.query(`UPDATE ${table} SET customer_invoice_id = NULL WHERE company_id = $1::uuid AND customer_invoice_id IS NOT NULL`, [companyId]);
  }
  for (const step of [...WIPE_STEPS, BALANCE_CACHE_STEP]) {
    const res = await tx.client.query(deleteSql(step), [companyId]);
    out.push({ table: step.table, n: res.rowCount ?? 0 });
  }
  const mb = await tx.client.query(
    'DELETE FROM imap_mirror_connections WHERE company_id = $1::uuid AND display_name ILIKE $2', [companyId, QA_MAILBOX_NAME]);
  out.push({ table: 'imap_mirror_connections (QA mailbox)', n: mb.rowCount ?? 0 });
  return out;
}
