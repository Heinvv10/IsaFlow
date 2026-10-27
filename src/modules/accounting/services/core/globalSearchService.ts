/**
 * Global Search Service — WS-3.1
 * Searches across 8 entity types with company-scoped ILIKE queries.
 */

import { log } from '@/lib/logger';
import {
  searchGlAccounts, searchCustomers, searchSuppliers, searchCustomerInvoices,
  searchJournalEntries, searchBankTransactions, searchItems, searchEmployees,
} from './globalSearchRecords';

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  url: string;
  icon: string;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function globalSearch(
  companyId: string,
  query: string,
  limit: number = 8,
): Promise<SearchResult[]> {
  // ILIKE's own wildcards in what the user typed match literally (backslash is ILIKE's default escape).
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  try {
    const [
      glAccountRows,
      customerRows,
      supplierRows,
      invoiceRows,
      journalRows,
      bankRows,
      itemRows,
      employeeRows,
    ] = await Promise.all([
      searchGlAccounts(companyId, pattern),
      searchCustomers(companyId, pattern),
      searchSuppliers(companyId, pattern),
      searchCustomerInvoices(companyId, pattern),
      searchJournalEntries(companyId, pattern),
      searchBankTransactions(companyId, pattern),
      searchItems(companyId, pattern),
      searchEmployees(companyId, pattern),
    ]);

    // Round-robin across entity types, so a low limit still shows every kind that matched.
    const groups = [glAccountRows, customerRows, supplierRows, invoiceRows, journalRows, bankRows, itemRows, employeeRows];
    const all: SearchResult[] = [];
    for (let i = 0; all.length < limit && groups.some((g) => i < g.length); i++) {
      for (const g of groups) if (g[i]) all.push(g[i]!);
    }

    return all.slice(0, limit);
  } catch (err) {
    log.error('Global search failed', { companyId, query, error: err }, 'global-search');
    throw err;
  }
}
