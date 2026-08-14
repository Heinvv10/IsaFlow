// tests/integration/continuous-close-state.test.ts
//
// buildCloseState was written against columns that do not exist on this schema
// (bank_transactions.gl_account_id, bank_transactions.matched, a status value
// of 'pending' that the CHECK constraint forbids, and
// customer_invoices.purchase_order_ref). Every call therefore failed with
// Postgres 42703 — undefined_column.
//
// These tests run the real queries against the real schema. They fail loudly
// if any referenced column disappears again, which a mocked-sql test cannot do.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { buildCloseState } from '@/modules/accounting/services/gl/continuousCloseQueryService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const COMPANY = '00000000-0000-0000-0000-0000000cc105';
const CUSTOMER = '00000000-0000-0000-0000-0000000cc1c0';
const BANK_ACCOUNT = '00000000-0000-0000-0000-0000000cc1ba';
const INVOICE_FULL = '00000000-0000-0000-0000-0000000cc1f0';
const INVOICE_SPARSE = '00000000-0000-0000-0000-0000000cc1f1';
const TX_UNCATEGORIZED = '00000000-0000-0000-0000-0000000cc1a0';
const TX_ALLOCATED = '00000000-0000-0000-0000-0000000cc1a1';
const TX_SUGGESTED = '00000000-0000-0000-0000-0000000cc1a2';
const JE_DRAFT = '00000000-0000-0000-0000-0000000cc1e0';
const JE_POSTED = '00000000-0000-0000-0000-0000000cc1e1';

describe('buildCloseState against the live schema', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Continuous Close Fixture', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY]
    );
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'CC Fixture Customer')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, COMPANY]
    );
    // bank_transactions.bank_account_id references gl_accounts(id), not bank_accounts(id).
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance)
       VALUES ($1, $2, 'CC-1000', 'CC Fixture Bank', 'asset', 'debit')
       ON CONFLICT (id) DO NOTHING`,
      [BANK_ACCOUNT, COMPANY]
    );

    // Complete draft invoice: customer + positive amount + both dates + a line.
    await admin.query(
      `INSERT INTO customer_invoices
         (id, company_id, customer_id, invoice_number, status, total_amount, subtotal, invoice_date, due_date, created_by)
       VALUES ($1, $2, $3, 'CC-FULL-1', 'draft', 1000, 1000, CURRENT_DATE, CURRENT_DATE + 30, 'fixture')
       ON CONFLICT (id) DO NOTHING`,
      [INVOICE_FULL, COMPANY, CUSTOMER]
    );
    await admin.query(
      `INSERT INTO customer_invoice_items (invoice_id, description, unit_price, amount)
       SELECT $1, 'CC Fixture Line', 1000, 1000
       WHERE NOT EXISTS (SELECT 1 FROM customer_invoice_items WHERE invoice_id = $1)`,
      [INVOICE_FULL]
    );

    // Sparse draft invoice: no dates, no lines, zero amount.
    await admin.query(
      `INSERT INTO customer_invoices
         (id, company_id, customer_id, invoice_number, status, total_amount, subtotal, invoice_date, due_date, created_by)
       VALUES ($1, $2, $3, 'CC-SPARSE-1', 'draft', 0, 0, NULL, NULL, 'fixture')
       ON CONFLICT (id) DO NOTHING`,
      [INVOICE_SPARSE, COMPANY, CUSTOMER]
    );

    // Awaiting work, no GL suggestion → uncategorized and unmatched.
    await admin.query(
      `INSERT INTO bank_transactions
         (id, company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1, $2, $3, CURRENT_DATE, -500, 'CC FIXTURE UNCATEGORIZED', 'imported')
       ON CONFLICT (id) DO NOTHING`,
      [TX_UNCATEGORIZED, COMPANY, BANK_ACCOUNT]
    );
    // Already allocated → neither uncategorized nor unmatched.
    await admin.query(
      `INSERT INTO bank_transactions
         (id, company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1, $2, $3, CURRENT_DATE, -900, 'CC FIXTURE ALLOCATED', 'allocated')
       ON CONFLICT (id) DO NOTHING`,
      [TX_ALLOCATED, COMPANY, BANK_ACCOUNT]
    );
    // Awaiting work but already has a GL suggestion → unmatched, NOT uncategorized.
    // This is the only fixture that separates the two queries.
    await admin.query(
      `INSERT INTO bank_transactions
         (id, company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id)
       VALUES ($1, $2, $3, CURRENT_DATE - 1, -700, 'CC FIXTURE SUGGESTED', 'imported', $3)
       ON CONFLICT (id) DO NOTHING`,
      [TX_SUGGESTED, COMPANY, BANK_ACCOUNT]
    );

    await admin.query(
      `INSERT INTO gl_journal_entries (id, company_id, entry_date, created_by, status)
       VALUES ($1, $2, CURRENT_DATE, '00000000-0000-0000-0000-000000000000', 'draft'), ($3, $2, CURRENT_DATE, '00000000-0000-0000-0000-000000000000', 'posted')
       ON CONFLICT (id) DO NOTHING`,
      [JE_DRAFT, COMPANY, JE_POSTED]
    );
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM gl_journal_entries WHERE company_id = $1`, [COMPANY]);
    await admin.query(`DELETE FROM bank_transactions WHERE company_id = $1`, [COMPANY]);
    await admin.query(`DELETE FROM customer_invoice_items WHERE invoice_id IN ($1, $2)`, [INVOICE_FULL, INVOICE_SPARSE]);
    await admin.query(`DELETE FROM customer_invoices WHERE company_id = $1`, [COMPANY]);
    await admin.query(`DELETE FROM gl_accounts WHERE company_id = $1`, [COMPANY]);
    await admin.query(`DELETE FROM customers WHERE company_id = $1`, [COMPANY]);
    await admin.query(`DELETE FROM companies WHERE id = $1`, [COMPANY]);
    await admin.end();
  });

  it('executes every query without a 42703 undefined_column error', async () => {
    const state = await buildCloseState(COMPANY);
    expect(state.uncategorizedTxCount).toBeGreaterThanOrEqual(0);
  });

  it('counts only transactions still awaiting work', async () => {
    const state = await buildCloseState(COMPANY);

    // Allocated transactions are excluded from both queues.
    expect(state.unmatchedTransactions.map(t => t.id).sort()).toEqual([TX_UNCATEGORIZED, TX_SUGGESTED].sort());
    expect(state.unmatchedTxCount).toBe(2);
  });

  it('excludes transactions that already carry a GL suggestion from the uncategorized queue', async () => {
    const state = await buildCloseState(COMPANY);

    expect(state.uncategorizedTransactions.map(t => t.id)).toEqual([TX_UNCATEGORIZED]);
    expect(state.uncategorizedTxCount).toBe(1);
  });

  it('lists draft journal entries only', async () => {
    const state = await buildCloseState(COMPANY);

    expect(state.pendingJournals.map(j => j.id)).toEqual([JE_DRAFT]);
    expect(state.pendingJournals[0]?.status).toBe('draft');
    expect(state.pendingJournalCount).toBe(1);
  });

  it('returns numeric amounts and confidences, not pg numeric strings', async () => {
    const state = await buildCloseState(COMPANY);

    expect(typeof state.uncategorizedTransactions[0]?.amount).toBe('number');
    for (const inv of state.pendingInvoices) {
      expect(typeof inv.amount).toBe('number');
      expect(typeof inv.confidence).toBe('number');
    }
  });

  it('scores a complete draft invoice at full confidence and a sparse one below the approval threshold', async () => {
    const state = await buildCloseState(COMPANY);

    const full = state.pendingInvoices.find(i => i.id === INVOICE_FULL);
    const sparse = state.pendingInvoices.find(i => i.id === INVOICE_SPARSE);

    expect(full?.confidence).toBeCloseTo(1, 5);
    // Sparse invoice has no completeness signal at all, so it must not clear
    // the 0.85 auto-approve threshold in planCloseActions.
    expect(sparse?.confidence).toBeCloseTo(0, 5);
  });

  it('scopes every result to the requesting company', async () => {
    const other = await buildCloseState('00000000-0000-0000-0000-00000000dead');

    expect(other.uncategorizedTransactions).toHaveLength(0);
    expect(other.unmatchedTransactions).toHaveLength(0);
    expect(other.pendingInvoices).toHaveLength(0);
    expect(other.pendingJournals).toHaveLength(0);
  });
});
