/**
 * Global Search Service — WS-3.1
 * Searches across 7 entity types with company-scoped ILIKE queries.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  url: string;
  icon: string;
}

export interface QuickAction {
  label: string;
  url: string;
  shortcut?: string;
  icon: string;
}

// ─── Quick Actions ────────────────────────────────────────────────────────────

export function getQuickActions(): QuickAction[] {
  return [
    { label: 'New Customer Invoice', url: '/accounting/customer-invoices/new', shortcut: 'Ctrl+Shift+I', icon: 'file-plus' },
    { label: 'New Journal Entry', url: '/accounting/journal-entries/new', shortcut: 'Ctrl+Shift+J', icon: 'plus-circle' },
    { label: 'New Customer', url: '/accounting/customers/new', icon: 'user-plus' },
    { label: 'New Supplier', url: '/accounting/suppliers/new', icon: 'truck' },
    { label: 'Bank Reconciliation', url: '/accounting/bank-reconciliation', icon: 'check-square' },
    { label: 'Reports', url: '/accounting/reports', icon: 'bar-chart-2' },
  ];
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function globalSearch(
  companyId: string,
  query: string,
  limit: number = 8,
): Promise<SearchResult[]> {
  const pattern = `%${query}%`;

  try {
    const [
      glAccountRows,
      customerRows,
      supplierRows,
      invoiceRows,
      journalRows,
      bankRows,
      itemRows,
    ] = await Promise.all([
      searchGlAccounts(companyId, pattern),
      searchCustomers(companyId, pattern),
      searchSuppliers(companyId, pattern),
      searchCustomerInvoices(companyId, pattern),
      searchJournalEntries(companyId, pattern),
      searchBankTransactions(companyId, pattern),
      searchItems(companyId, pattern),
    ]);

    const all: SearchResult[] = [
      ...glAccountRows,
      ...customerRows,
      ...supplierRows,
      ...invoiceRows,
      ...journalRows,
      ...bankRows,
      ...itemRows,
    ];

    return all.slice(0, limit);
  } catch (err) {
    log.error('Global search failed', { companyId, query, error: err }, 'global-search');
    throw err;
  }
}

// ─── Per-entity search helpers ────────────────────────────────────────────────

async function searchGlAccounts(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, account_code, account_name, account_type
      FROM gl_accounts
      WHERE company_id = ${companyId}
        AND (account_code ILIKE ${pattern} OR account_name ILIKE ${pattern})
        AND is_active = true
      LIMIT 3
    ` as { id: string; account_code: string; account_name: string; account_type: string }[];

    return rows.map(r => ({
      type: 'gl_account',
      id: String(r.id),
      title: `${r.account_code} — ${r.account_name}`,
      subtitle: String(r.account_type),
      url: '/accounting?tab=accounts',
      icon: 'book-open',
    }));
  } catch (err) {
    log.warn('GL account search failed', { error: err }, 'global-search');
    return [];
  }
}

async function searchCustomers(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, name, account_number
      FROM customers
      WHERE company_id = ${companyId}
        AND (name ILIKE ${pattern} OR account_number ILIKE ${pattern})
        AND deleted_at IS NULL
      LIMIT 3
    ` as { id: string; name: string; account_number: string | null }[];

    return rows.map(r => ({
      type: 'customer',
      id: String(r.id),
      title: String(r.name),
      subtitle: r.account_number ? String(r.account_number) : '',
      url: `/accounting/customers?id=${r.id}`,
      icon: 'users',
    }));
  } catch (err) {
    // Retry without deleted_at in case column does not exist yet
    try {
      const rows = await sql`
        SELECT id, name, account_number
        FROM customers
        WHERE company_id = ${companyId}
          AND (name ILIKE ${pattern} OR account_number ILIKE ${pattern})
        LIMIT 3
      ` as { id: string; name: string; account_number: string | null }[];

      return rows.map(r => ({
        type: 'customer',
        id: String(r.id),
        title: String(r.name),
        subtitle: r.account_number ? String(r.account_number) : '',
        url: `/accounting/customers?id=${r.id}`,
        icon: 'users',
      }));
    } catch (innerErr) {
      log.warn('Customer search failed', { error: innerErr }, 'global-search');
      return [];
    }
  }
}

async function searchSuppliers(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, name, account_number
      FROM suppliers
      WHERE company_id = ${companyId}
        AND (name ILIKE ${pattern} OR account_number ILIKE ${pattern})
        AND deleted_at IS NULL
      LIMIT 3
    ` as { id: string; name: string; account_number: string | null }[];

    return rows.map(r => ({
      type: 'supplier',
      id: String(r.id),
      title: String(r.name),
      subtitle: r.account_number ? String(r.account_number) : '',
      url: `/accounting/suppliers?id=${r.id}`,
      icon: 'truck',
    }));
  } catch (err) {
    try {
      const rows = await sql`
        SELECT id, name, account_number
        FROM suppliers
        WHERE company_id = ${companyId}
          AND (name ILIKE ${pattern} OR account_number ILIKE ${pattern})
        LIMIT 3
      ` as { id: string; name: string; account_number: string | null }[];

      return rows.map(r => ({
        type: 'supplier',
        id: String(r.id),
        title: String(r.name),
        subtitle: r.account_number ? String(r.account_number) : '',
        url: `/accounting/suppliers?id=${r.id}`,
        icon: 'truck',
      }));
    } catch (innerErr) {
      log.warn('Supplier search failed', { error: innerErr }, 'global-search');
      return [];
    }
  }
}

async function searchCustomerInvoices(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, invoice_number, customer_name, total
      FROM customer_invoices
      WHERE company_id = ${companyId}
        AND (invoice_number ILIKE ${pattern} OR customer_name ILIKE ${pattern})
      LIMIT 3
    ` as { id: string; invoice_number: string; customer_name: string; total: string | number }[];

    return rows.map(r => ({
      type: 'invoice',
      id: String(r.id),
      title: String(r.invoice_number),
      subtitle: `${r.customer_name} | R ${Number(r.total).toFixed(2)}`,
      url: `/accounting/customer-invoices?id=${r.id}`,
      icon: 'file-text',
    }));
  } catch (err) {
    log.warn('Customer invoice search failed', { error: err }, 'global-search');
    return [];
  }
}

async function searchJournalEntries(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, entry_number, description
      FROM gl_journal_entries
      WHERE company_id = ${companyId}
        AND (entry_number ILIKE ${pattern} OR description ILIKE ${pattern})
      LIMIT 3
    ` as { id: string; entry_number: string; description: string | null }[];

    return rows.map(r => ({
      type: 'journal_entry',
      id: String(r.id),
      title: String(r.entry_number),
      subtitle: r.description ? String(r.description) : '',
      url: `/accounting/journal-entries?id=${r.id}`,
      icon: 'scroll',
    }));
  } catch (err) {
    log.warn('Journal entry search failed', { error: err }, 'global-search');
    return [];
  }
}

async function searchBankTransactions(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, description, reference, amount
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND (description ILIKE ${pattern} OR reference ILIKE ${pattern})
      LIMIT 3
    ` as { id: string; description: string; reference: string | null; amount: string | number }[];

    return rows.map(r => ({
      type: 'bank_transaction',
      id: String(r.id),
      title: String(r.description),
      subtitle: `R ${Number(r.amount).toFixed(2)}${r.reference ? ` | ${r.reference}` : ''}`,
      url: '/accounting/bank-transactions',
      icon: 'landmark',
    }));
  } catch (err) {
    log.warn('Bank transaction search failed', { error: err }, 'global-search');
    return [];
  }
}

async function searchItems(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, item_code, item_name
      FROM items
      WHERE company_id = ${companyId}
        AND (item_code ILIKE ${pattern} OR item_name ILIKE ${pattern})
      LIMIT 3
    ` as { id: string; item_code: string; item_name: string }[];

    return rows.map(r => ({
      type: 'item',
      id: String(r.id),
      title: `${r.item_code} — ${r.item_name}`,
      subtitle: '',
      url: `/accounting/items?id=${r.id}`,
      icon: 'package',
    }));
  } catch (err) {
    log.warn('Items search failed', { error: err }, 'global-search');
    return [];
  }
}
