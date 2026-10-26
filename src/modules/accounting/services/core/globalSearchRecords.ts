/**
 * Per-entity record searchers behind the command palette. Each is scoped by company_id and swallows its own
 * SQL error (a warn in the log) so one broken entity never empties the whole search.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { SearchResult } from './globalSearchService';

// ─── Per-entity search helpers ────────────────────────────────────────────────

export async function searchGlAccounts(companyId: string, pattern: string): Promise<SearchResult[]> {
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

export async function searchCustomers(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, name, email
      FROM customers
      WHERE company_id = ${companyId}
        AND (name ILIKE ${pattern} OR email ILIKE ${pattern})
        AND deleted_at IS NULL
      LIMIT 3
    ` as { id: string; name: string; email: string | null }[];

    return rows.map(r => ({
      type: 'customer',
      id: String(r.id),
      title: String(r.name),
      subtitle: r.email ? String(r.email) : '',
      url: `/accounting/customers?id=${r.id}`,
      icon: 'users',
    }));
  } catch (err) {
    log.warn('Customer search failed', { error: err }, 'global-search');
    return [];
  }
}

export async function searchSuppliers(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, name, email
      FROM suppliers
      WHERE company_id = ${companyId}
        AND (name ILIKE ${pattern} OR email ILIKE ${pattern})
        AND deleted_at IS NULL
      LIMIT 3
    ` as { id: string; name: string; email: string | null }[];

    return rows.map(r => ({
      type: 'supplier',
      id: String(r.id),
      title: String(r.name),
      subtitle: r.email ? String(r.email) : '',
      url: `/accounting/suppliers?id=${r.id}`,
      icon: 'truck',
    }));
  } catch (err) {
    log.warn('Supplier search failed', { error: err }, 'global-search');
    return [];
  }
}

export async function searchCustomerInvoices(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT ci.id, ci.invoice_number, c.name AS customer_name, ci.total_amount
      FROM customer_invoices ci
      -- A soft-deleted customer still names its invoices: the invoice stands, so does whose it is.
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
      WHERE ci.company_id = ${companyId}
        AND ci.deleted_at IS NULL
        AND (ci.invoice_number ILIKE ${pattern} OR c.name ILIKE ${pattern})
      LIMIT 3
    ` as { id: string; invoice_number: string; customer_name: string | null; total_amount: string | number }[];

    return rows.map(r => ({
      type: 'invoice',
      id: String(r.id),
      title: String(r.invoice_number),
      subtitle: `${r.customer_name ? `${r.customer_name} | ` : ''}R ${Number(r.total_amount).toFixed(2)}`,
      url: `/accounting/customer-invoices?id=${r.id}`,
      icon: 'file-text',
    }));
  } catch (err) {
    log.warn('Customer invoice search failed', { error: err }, 'global-search');
    return [];
  }
}

export async function searchJournalEntries(companyId: string, pattern: string): Promise<SearchResult[]> {
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

export async function searchBankTransactions(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, description, reference, amount
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND feed_state <> 'removed'
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

export async function searchItems(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, code, description
      FROM items
      WHERE company_id = ${companyId}
        AND deleted_at IS NULL
        AND (code ILIKE ${pattern} OR description ILIKE ${pattern})
      LIMIT 3
    ` as { id: string; code: string; description: string }[];

    return rows.map(r => ({
      type: 'item',
      id: String(r.id),
      title: `${r.code} — ${r.description}`,
      subtitle: '',
      url: `/accounting/items?id=${r.id}`,
      icon: 'package',
    }));
  } catch (err) {
    log.warn('Items search failed', { error: err }, 'global-search');
    return [];
  }
}

/**
 * Active employees by name or number. Visibility matches GET /api/payroll/employees: any member of the company,
 * and only what that route gives a read-only role (name and employee number, nothing personal).
 */
export async function searchEmployees(companyId: string, pattern: string): Promise<SearchResult[]> {
  try {
    const rows = await sql`
      SELECT id, employee_number, first_name, last_name
      FROM payroll_employees
      WHERE company_id = ${companyId}::uuid
        AND status = 'active'
        AND ((first_name || ' ' || last_name) ILIKE ${pattern} OR employee_number ILIKE ${pattern})
      ORDER BY last_name, first_name
      LIMIT 3
    ` as { id: string; employee_number: string; first_name: string; last_name: string }[];

    return rows.map(r => ({
      type: 'employee',
      id: String(r.id),
      title: `${r.first_name} ${r.last_name}`,
      subtitle: String(r.employee_number),
      url: `/payroll/employees/${r.id}`,
      icon: 'user-round',
    }));
  } catch (err) {
    log.warn('Employee search failed', { error: err }, 'global-search');
    return [];
  }
}
