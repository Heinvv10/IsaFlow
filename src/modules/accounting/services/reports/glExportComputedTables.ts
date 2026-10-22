/**
 * The export's COMPUTED tables — `ap_open_items`, `ar_open_items` and
 * `bank_accounts` — beside the dimension masters in glLineExportTables.
 *
 * Computed, not read: each is built whole by its owning report's services
 * (reports/openItemsExport, reports/bankAccountsExport), so the summary's
 * control figures describe the complete table, never a page. Paging is a
 * keyset over the built rows' total order — (Doc_Type, Doc_ID) for open items,
 * ('', Bank_Account_ID) for bank accounts — so the MCP cursor carries a kind
 * and an id like the master tables' cursors, and no name or amount.
 */

import { buildOpenItems, openItemKey, type OpenItemsSummary } from './openItemsExport';
import { buildBankAccounts, type BankAccountsSummary } from './bankAccountsExport';
import type { ExportValue } from './glLineExportRows';
import type { GlTableCursor } from './glLineExportTables';

export const GL_COMPUTED_TABLES = ['ap_open_items', 'ar_open_items', 'bank_accounts'] as const;
export type GlComputedTable = (typeof GL_COMPUTED_TABLES)[number];

export function isGlComputedTable(v: unknown): v is GlComputedTable {
  return typeof v === 'string' && (GL_COMPUTED_TABLES as readonly string[]).includes(v);
}

/** The cursor kinds a computed table's keyset can carry. */
export const GL_COMPUTED_CURSOR_KINDS: readonly string[] = [
  '', 'invoice', 'credit_note', 'unapplied_payment', 'unapplied_receipt',
];

export type ComputedSummary = OpenItemsSummary | BankAccountsSummary;

export interface ComputedTable {
  columns: readonly string[];
  rows: Array<Record<string, ExportValue>>;
  summary: ComputedSummary;
}

export interface ComputedTablePage {
  columns: readonly string[];
  rows: Array<Record<string, ExportValue>>;
  next: GlTableCursor | null;
}

/** The whole table and its control summary, as at today. */
export async function buildComputedTable(companyId: string, table: GlComputedTable): Promise<ComputedTable> {
  if (table === 'bank_accounts') return buildBankAccounts(companyId);
  return buildOpenItems(companyId, table === 'ap_open_items' ? 'ap' : 'ar');
}

/** A row's position in the table's total order. */
export function computedRowKey(table: GlComputedTable, row: Record<string, ExportValue>): GlTableCursor {
  return table === 'bank_accounts' ? ['', String(row.Bank_Account_ID)] : openItemKey(row);
}

const after = (a: GlTableCursor, b: GlTableCursor): boolean =>
  a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** The `limit` rows after `cursor` (from the start when null), and the cursor of the next page. */
export function pageComputedTable(
  table: GlComputedTable,
  built: ComputedTable,
  cursor: GlTableCursor | null,
  limit: number,
): ComputedTablePage {
  const rest = cursor === null ? built.rows : built.rows.filter((r) => after(computedRowKey(table, r), cursor));
  const rows = rest.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    columns: built.columns,
    rows,
    next: last === undefined || rest.length <= limit ? null : computedRowKey(table, last),
  };
}
