/**
 * parseSupplierInvoiceInput must refuse a value its column cannot hold.
 *
 * supplier_invoices.invoice_number is VARCHAR(50). A longer value reached the
 * INSERT and Postgres raised 22001 — "value too long for type character
 * varying(50)", which names no column — so the agent saw a generic database
 * error, and in bulk_create_supplier_invoices that one element unwound the
 * whole batch. Refused here, the reply names the field and the limit, and the
 * bulk tool names the element before anything is written.
 */

import { describe, it, expect } from 'vitest';
import { parseCustomerInvoiceInput, parseSupplierInvoiceInput } from '@/lib/mcp/tools/invoiceCreateArgs';
import { partitionSupplierInvoiceBatch } from '@/lib/mcp/tools/bulkInvoiceDuplicateSkip';

const SUPPLIER = '11111111-1111-4111-8111-111111111111';

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplier_id: SUPPLIER,
    invoice_number: 'INV-1',
    invoice_date: '2026-09-01',
    lines: [{ description: 'Widget', quantity: 1, unit_price: 100 }],
    ...overrides,
  };
}

describe('parseSupplierInvoiceInput — column widths', () => {
  it('accepts an invoice_number of exactly 50 characters', () => {
    const parsed = parseSupplierInvoiceInput(args({ invoice_number: 'X'.repeat(50) }));
    expect(typeof parsed).not.toBe('string');
  });

  it('refuses an invoice_number over 50 characters, naming the field, length and limit', () => {
    const parsed = parseSupplierInvoiceInput(args({ invoice_number: 'X'.repeat(51) }));
    expect(parsed).toBe('invoice_number is 51 characters; the maximum is 50');
  });

  it('refuses a payment_terms over 50 characters', () => {
    const parsed = parseSupplierInvoiceInput(args({ payment_terms: 'n'.repeat(51) }));
    expect(parsed).toBe('payment_terms is 51 characters; the maximum is 50');
  });

  it('refuses a reference over 255 characters', () => {
    const parsed = parseSupplierInvoiceInput(args({ reference: 'r'.repeat(256) }));
    expect(parsed).toBe('reference is 256 characters; the maximum is 255');
  });

  it('measures the TRIMMED value — the one that is stored', () => {
    const parsed = parseSupplierInvoiceInput(args({ invoice_number: `  ${'X'.repeat(50)}  ` }));
    expect(typeof parsed).not.toBe('string');
  });
});

describe('bulk_create_supplier_invoices — the path the 50-char limit killed', () => {
  it('refuses the batch pre-write, naming the element that is over the limit', () => {
    const batch = [
      args({ invoice_number: 'OK-1' }),
      args({ invoice_number: 'OK-2' }),
      args({ invoice_number: 'Y'.repeat(64) }),
    ];
    expect(partitionSupplierInvoiceBatch(batch))
      .toBe('invoices[2].invoice_number is 64 characters; the maximum is 50');
  });
});

describe('parseCustomerInvoiceInput — line coding (migration 870)', () => {
  const ACCOUNT = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
  const PROJECT = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
  const customer = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => parseCustomerInvoiceInput({
    customer_id: SUPPLIER, items: [{ description: 'Spot', unit_price: 100, ...item }], ...extra,
  });

  it('reads each line\'s account, project and cost centre, and the header project', () => {
    const parsed = customer({ gl_account_id: ACCOUNT.toUpperCase(), project_id: PROJECT }, { project_id: PROJECT });
    expect(parsed).toMatchObject({
      items: [{ description: 'Spot', unitPrice: 100, quantity: 1, glAccountId: ACCOUNT, projectId: PROJECT, costCenterId: null }],
      projectId: PROJECT,
    });
  });

  it('an uncoded line and no header project parse as nulls', () => {
    expect(customer({})).toMatchObject({
      items: [{ glAccountId: null, projectId: null, costCenterId: null }], projectId: null,
    });
  });

  it('refuses a coding id that is not a uuid string, naming the line and field, before any write', () => {
    expect(customer({ gl_account_id: [ACCOUNT] })).toBe('items[0].gl_account_id must be a UUID');
    expect(customer({ cost_center_id: 7 })).toBe('items[0].cost_center_id must be a UUID');
    expect(customer({}, { project_id: { id: PROJECT } })).toBe('project_id must be a UUID');
  });
});
