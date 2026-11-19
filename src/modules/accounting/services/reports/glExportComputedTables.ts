/**
 * The export's COMPUTED tables — `ap_open_items`, `ar_open_items`,
 * `bank_accounts`, `budget_versions` and `budgets` — beside the dimension
 * masters in glLineExportTables.
 *
 * Computed, not read: each is built whole by its owning report's services
 * (reports/openItemsExport, reports/bankAccountsExport, reports/budgetsExport),
 * so the summary's control figures describe the complete table, never a page.
 * Paging (the MCP tool's) is a keyset over the built rows' total order —
 * (Doc_Type, Doc_ID) for open items, ('', Bank_Account_ID) for bank accounts —
 * so the MCP cursor carries a kind and an id like the master tables' cursors,
 * and no name or amount. The budget tables are REST only (GL_BUDGET_TABLES):
 * a budget row has no single id, so they are never paged here.
 */

import { buildOpenItems, openItemKey, type OpenItemsSummary } from './openItemsExport';
import { buildBankAccounts, type BankAccountsSummary } from './bankAccountsExport';
import { buildBudgetVersions, buildBudgets } from './budgetsExport';
import type { BudgetVersionsSummary, BudgetsSummary } from './budgetsExportRows';
import type { ExportValue } from './glLineExportRows';
import { GL_COMPUTED_TABLES, type GlBudgetTable, type GlTableCursor } from './glLineExportTables';

export { GL_COMPUTED_TABLES };
export type GlComputedTable = (typeof GL_COMPUTED_TABLES)[number];
/** The computed tables the MCP tool pages: every one but the budget tables. */
export type GlPagedComputedTable = Exclude<GlComputedTable, GlBudgetTable>;

export function isGlComputedTable(v: unknown): v is GlComputedTable {
  return typeof v === 'string' && (GL_COMPUTED_TABLES as readonly string[]).includes(v);
}

/** The cursor kinds a computed table's keyset can carry. */
export const GL_COMPUTED_CURSOR_KINDS: readonly string[] = [
  '', 'invoice', 'credit_note', 'unapplied_payment', 'unapplied_receipt',
];

export type ComputedSummary = OpenItemsSummary | BankAccountsSummary | BudgetVersionsSummary | BudgetsSummary;

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
  switch (table) {
    case 'bank_accounts': return buildBankAccounts(companyId);
    case 'budget_versions': return buildBudgetVersions(companyId);
    case 'budgets': return buildBudgets(companyId);
    case 'ap_open_items': return buildOpenItems(companyId, 'ap');
    case 'ar_open_items': return buildOpenItems(companyId, 'ar');
  }
}

/**
 * The summary facts a CSV download carries as headers, exact because the
 * table is built whole before the first byte. Open items: X-Aged-Total and
 * X-Control-Difference (an internal consistency check, not a GL tie — see
 * openItemsExport) and X-Disputed-Total (what Outstanding leaves out, already
 * inside X-Control-Total). Bank accounts: X-No-Ledger-Balance-Count, the rows
 * X-Control-Total leaves out. Budgets: X-Control-Total = Σ Amount. Budget
 * versions carry no amount, so NO X-Control-Total (never a made-up 0.00).
 */
export function computedHeaders(summary: ComputedSummary): Record<string, string> {
  const headers: Record<string, string> = {
    'X-As-At': summary.asAt,
    'X-Row-Count': String(summary.rowCount),
  };
  switch (summary.table) {
    case 'budget_versions':
      break;
    case 'budgets':
      headers['X-Control-Total'] = summary.controlTotal.toFixed(2);
      break;
    case 'bank_accounts':
      headers['X-Control-Total'] = summary.controlTotal.toFixed(2);
      headers['X-No-Ledger-Balance-Count'] = String(summary.noLedgerBalanceCount);
      break;
    case 'ap_open_items':
    case 'ar_open_items':
      headers['X-Control-Total'] = summary.controlTotal.toFixed(2);
      headers['X-Aged-Total'] = summary.agedTotal.toFixed(2);
      headers['X-Control-Difference'] = summary.difference.toFixed(2);
      headers['X-Disputed-Total'] = summary.disputedTotal.toFixed(2);
      break;
  }
  return headers;
}

/** A row's position in the table's total order. */
export function computedRowKey(table: GlPagedComputedTable, row: Record<string, ExportValue>): GlTableCursor {
  return table === 'bank_accounts' ? ['', String(row.Bank_Account_ID)] : openItemKey(row);
}

const after = (a: GlTableCursor, b: GlTableCursor): boolean =>
  a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** The `limit` rows after `cursor` (from the start when null), and the cursor of the next page. */
export function pageComputedTable(
  table: GlPagedComputedTable,
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
