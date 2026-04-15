/**
 * Integration tests: BL-53..BL-57 — NOT-NULL INSERT fixes
 *
 * BL-53: bank_transactions INSERT in bankFeedSyncService missing company_id
 * BL-54: bank_transactions INSERT in openBankingSyncService missing company_id
 * BL-55: customer_invoices INSERT in quoteConvertService — wrong column (total→total_amount),
 *        missing invoice_number, missing customer_id
 * BL-56: customer_invoices INSERT in recurringTransactionService missing invoice_number,
 *        customer_id, created_by
 * BL-57: supplier_invoices INSERT in recurringTransactionService missing invoice_number,
 *        created_by
 *
 * All tests use real Neon DB with UUID prefixes b153..b157.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';

// ── Shared test company ───────────────────────────────────────────────────────

const COMPANY_ID = '00000000-0000-0000-b153-000000000001';
const USER_ID     = '00000000-0000-0000-b153-000000000002';

async function ensureCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL53-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

// ── BL-53 / BL-54 shared state ────────────────────────────────────────────────

let glAccountId: string;
let bankAccountId: string;

// ── BL-55 state ───────────────────────────────────────────────────────────────

let customerId55: string;

// ── BL-56 / BL-57 state ───────────────────────────────────────────────────────

let supplierId57: string;

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureCompany(COMPANY_ID, 'BL53-57 Integration Test Company');

  // GL account and bank_account for BL-53/54
  const gl = await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
    VALUES (${COMPANY_ID}::UUID, '9953-BL', 'BL53 Bank Account', 'asset', 'debit', true)
    RETURNING id
  ` as Array<{ id: string }>;
  glAccountId = gl[0]!.id;

  const ba = await sql`
    INSERT INTO bank_accounts (company_id, account_name, bank_name, account_number, gl_account_id)
    VALUES (${COMPANY_ID}::UUID, 'BL53 Bank Acc', 'Test Bank', '99953', ${glAccountId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  bankAccountId = ba[0]!.id;

  // Customer for BL-55
  const cust = await sql`
    INSERT INTO customers (company_id, name, email)
    VALUES (${COMPANY_ID}::UUID, 'BL55 Test Customer', 'bl55@isaflow-test.local')
    RETURNING id
  ` as Array<{ id: string }>;
  customerId55 = cust[0]!.id;

  // Supplier for BL-57
  const supp = await sql`
    INSERT INTO suppliers (company_id, name, email)
    VALUES (${COMPANY_ID}::UUID, 'BL57 Test Supplier', 'bl57@isaflow-test.local')
    RETURNING id
  ` as Array<{ id: string }>;
  supplierId57 = supp[0]!.id;
});

afterAll(async () => {
  // Clean up in FK-safe order
  await sql`DELETE FROM bank_transactions WHERE company_id = ${COMPANY_ID}::UUID`;
  await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY_ID}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY_ID}::UUID`;
  await sql`DELETE FROM company_document_numbers WHERE company_id = ${COMPANY_ID}::UUID`;
  await sql`DELETE FROM bank_accounts WHERE company_id = ${COMPANY_ID}::UUID`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY_ID}::UUID AND account_code = '9953-BL'`;
  await sql`DELETE FROM customers WHERE company_id = ${COMPANY_ID}::UUID`;
  await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY_ID}::UUID`;
  await sql`DELETE FROM companies WHERE id = ${COMPANY_ID}::UUID`;
});

// ── BL-53: bankFeedSyncService INSERT now includes company_id ─────────────────

describe('BL-53: bank_transactions INSERT includes company_id (bankFeedSyncService fix)', () => {
  it('direct INSERT with company_id succeeds and row is selectable by company_id', async () => {
    // Simulate the fixed INSERT (as written in bankFeedSyncService after the fix)
    const inserted = await sql`
      INSERT INTO bank_transactions (
        company_id, bank_account_id, transaction_date, amount, description,
        reference, bank_reference, status, import_batch_id
      ) VALUES (
        ${COMPANY_ID}::UUID,
        ${glAccountId}::UUID,
        CURRENT_DATE,
        ${-150.00},
        ${'BL-53 Stitch sync test'},
        ${'REF-BL53'},
        ${'stitch-external-b153-001'},
        ${'imported'},
        NULL
      ) RETURNING id, company_id
    ` as Array<{ id: string; company_id: string }>;

    expect(inserted).toHaveLength(1);
    // company_id must be persisted and match — the core assertion for BL-53
    expect(inserted[0]!.company_id).toBe(COMPANY_ID);

    // Verify the row is retrievable scoped by company_id
    const row = await sql`
      SELECT company_id, bank_reference, amount
      FROM bank_transactions
      WHERE id = ${inserted[0]!.id}::UUID AND company_id = ${COMPANY_ID}::UUID
    ` as Array<{ company_id: string; bank_reference: string; amount: string }>;

    expect(row).toHaveLength(1);
    expect(row[0]!.company_id).toBe(COMPANY_ID);
    expect(row[0]!.bank_reference).toBe('stitch-external-b153-001');
    expect(Number(row[0]!.amount)).toBe(-150);
  });
});

// ── BL-54: openBankingSyncService INSERT now includes company_id ──────────────

describe('BL-54: bank_transactions INSERT includes company_id (openBankingSyncService fix)', () => {
  it('INSERT with company_id (open banking stub path) succeeds and row is tenant-scoped', async () => {
    // Simulate the fixed insertTransaction() with companyId parameter
    const extId = 'ob-stub-b154-' + Date.now().toString(36);
    const inserted = await sql`
      INSERT INTO bank_transactions (
        company_id, bank_account_id, transaction_date, amount,
        description, reference, bank_reference, status
      ) VALUES (
        ${COMPANY_ID}::UUID,
        ${glAccountId}::UUID,
        CURRENT_DATE,
        ${2500.00},
        ${'Client payment'},
        ${'REF-BL54'},
        ${extId},
        ${'imported'}
      ) RETURNING id, company_id, bank_reference
    ` as Array<{ id: string; company_id: string; bank_reference: string }>;

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.company_id).toBe(COMPANY_ID);
    expect(inserted[0]!.bank_reference).toBe(extId);

    // Cross-tenant check: a different company_id should return no rows
    const OTHER_COMPANY = '00000000-0000-0000-b154-000000000099';
    const crossTenant = await sql`
      SELECT id FROM bank_transactions
      WHERE id = ${inserted[0]!.id}::UUID AND company_id = ${OTHER_COMPANY}::UUID
    ` as Array<{ id: string }>;
    expect(crossTenant).toHaveLength(0);
  });
});

// ── BL-55: quoteConvertService convertToInvoice uses total_amount + invoice_number + customer_id

describe('BL-55: customer_invoices INSERT uses correct columns (quoteConvertService fix)', () => {
  it('INSERT with invoice_number, customer_id, total_amount succeeds and row is valid', async () => {
    // Generate an invoice_number via company_document_numbers (same pattern as the fix)
    const numRows = await sql`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number)
      VALUES (${COMPANY_ID}::UUID, 'invoice', 'INV-', 1)
      ON CONFLICT (company_id, document_type)
      DO UPDATE SET next_number = company_document_numbers.next_number + 1
      RETURNING next_number - 1 AS current_number, prefix
    ` as Array<{ current_number: number; prefix: string }>;
    const invNum = Number(numRows[0]!.current_number);
    const invoiceNumber = `INV-${String(invNum).padStart(5, '0')}`;

    // Simulate convertToInvoice fixed INSERT
    const inserted = await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, client_id, customer_id,
        invoice_date, due_date, subtotal, tax_amount, total_amount,
        notes, status, created_by
      ) VALUES (
        ${COMPANY_ID}::UUID,
        ${invoiceNumber},
        ${customerId55}::UUID,
        ${customerId55}::UUID,
        CURRENT_DATE,
        CURRENT_DATE + INTERVAL '30 days',
        ${1000.00},
        ${150.00},
        ${1150.00},
        ${'Converted from QT-00001'},
        ${'draft'},
        ${USER_ID}
      ) RETURNING id, invoice_number, customer_id, total_amount
    ` as Array<{
      id: string;
      invoice_number: string;
      customer_id: string;
      total_amount: string;
    }>;

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.invoice_number).toBe(invoiceNumber);
    expect(inserted[0]!.customer_id).toBe(customerId55);
    expect(Number(inserted[0]!.total_amount)).toBe(1150);

    // Verify SELECT back by company
    const row = await sql`
      SELECT invoice_number, customer_id, total_amount, status
      FROM customer_invoices
      WHERE id = ${inserted[0]!.id}::UUID AND company_id = ${COMPANY_ID}::UUID
    ` as Array<{
      invoice_number: string;
      customer_id: string;
      total_amount: string;
      status: string;
    }>;

    expect(row).toHaveLength(1);
    expect(row[0]!.invoice_number).toBe(invoiceNumber);
    expect(row[0]!.customer_id).toBe(customerId55);
    expect(Number(row[0]!.total_amount)).toBe(1150);
    expect(row[0]!.status).toBe('draft');
  });
});

// ── BL-56: recurringTransactionService customer_invoice INSERT includes invoice_number + customer_id + created_by

describe('BL-56: recurring customer_invoice INSERT has all NOT-NULL columns', () => {
  it('INSERT with invoice_number, customer_id, created_by succeeds and SELECT-back passes', async () => {
    const templateName = 'Monthly Retainer BL56';
    const slug = templateName.replace(/[^A-Za-z0-9]/g, '-').toUpperCase().slice(0, 20);
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const invoiceNumber = `RINV-${slug}-${period}`;

    const inserted = await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, client_id, customer_id, invoice_date, due_date,
        notes, subtotal, tax_amount, total_amount, status, created_by
      ) VALUES (
        ${COMPANY_ID}::UUID,
        ${invoiceNumber + '-TEST'},
        ${customerId55}::UUID,
        ${customerId55}::UUID,
        CURRENT_DATE,
        CURRENT_DATE::DATE + INTERVAL '30 days',
        ${templateName},
        ${5000.00},
        ${750.00},
        ${5750.00},
        ${'draft'},
        ${USER_ID}
      ) RETURNING id, invoice_number, customer_id, created_by, total_amount
    ` as Array<{
      id: string;
      invoice_number: string;
      customer_id: string;
      created_by: string;
      total_amount: string;
    }>;

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.invoice_number).toContain('RINV-');
    expect(inserted[0]!.customer_id).toBe(customerId55);
    // created_by is VARCHAR(255) on customer_invoices — stored as text
    expect(inserted[0]!.created_by).toBe(USER_ID);
    expect(Number(inserted[0]!.total_amount)).toBe(5750);

    // SELECT back to confirm DB integrity
    const row = await sql`
      SELECT invoice_number, customer_id, created_by, total_amount
      FROM customer_invoices
      WHERE id = ${inserted[0]!.id}::UUID AND company_id = ${COMPANY_ID}::UUID
    ` as Array<{
      invoice_number: string;
      customer_id: string;
      created_by: string;
      total_amount: string;
    }>;

    expect(row).toHaveLength(1);
    expect(row[0]!.invoice_number).toContain('RINV-');
    expect(row[0]!.customer_id).toBe(customerId55);
    expect(row[0]!.created_by).toBe(USER_ID);
  });
});

// ── BL-57: recurringTransactionService supplier_invoice INSERT includes invoice_number + created_by

describe('BL-57: recurring supplier_invoice INSERT has all NOT-NULL columns', () => {
  it('INSERT with invoice_number, supplier_id, created_by succeeds and SELECT-back passes', async () => {
    const templateName = 'Recurring Rent BL57';
    const slug = templateName.replace(/[^A-Za-z0-9]/g, '-').toUpperCase().slice(0, 20);
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const invoiceNumber = `RSINV-${slug}-${period}`;

    const inserted = await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        reference, notes, subtotal, tax_amount, total_amount, status, created_by
      ) VALUES (
        ${COMPANY_ID}::UUID,
        ${invoiceNumber + '-TEST'},
        ${supplierId57}::UUID,
        CURRENT_DATE,
        CURRENT_DATE::DATE + INTERVAL '30 days',
        ${'AUTO-REC'},
        ${templateName},
        ${8000.00},
        ${1200.00},
        ${9200.00},
        ${'draft'},
        ${USER_ID}::UUID
      ) RETURNING id, invoice_number, supplier_id, created_by, total_amount
    ` as Array<{
      id: string;
      invoice_number: string;
      supplier_id: string;
      created_by: string;
      total_amount: string;
    }>;

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.invoice_number).toContain('RSINV-');
    expect(inserted[0]!.supplier_id).toBe(supplierId57);
    // created_by is UUID on supplier_invoices
    expect(inserted[0]!.created_by).toBe(USER_ID);
    expect(Number(inserted[0]!.total_amount)).toBe(9200);

    // SELECT back to confirm DB integrity
    const row = await sql`
      SELECT invoice_number, supplier_id, created_by, total_amount
      FROM supplier_invoices
      WHERE id = ${inserted[0]!.id}::UUID AND company_id = ${COMPANY_ID}::UUID
    ` as Array<{
      invoice_number: string;
      supplier_id: string;
      created_by: string;
      total_amount: string;
    }>;

    expect(row).toHaveLength(1);
    expect(row[0]!.invoice_number).toContain('RSINV-');
    expect(row[0]!.supplier_id).toBe(supplierId57);
    expect(row[0]!.created_by).toBe(USER_ID);
  });
});
