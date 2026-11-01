/**
 * Migration 708's approval_document_digest hashes a supplier invoice's lines in a fixed ORDER BY, and the two TypeScript
 * readers (getSupplierInvoice, planLines) share SUPPLIER_INVOICE_LINE_ORDER_BY. The migration cannot import the constant,
 * so this reads the migration's text: if either side changes alone, this goes red. (Never edit 708: it is applied.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '@/modules/accounting/services/ap/supplierInvoiceLineOrder';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const migration = readFileSync(path.join(process.cwd(), 'scripts/migrations/sql/708_approval_enforcement_infra.sql'), 'utf8');

describe('supplier invoice line order', () => {
  it('is the ORDER BY of the jsonb_agg in migration 708\'s approval_document_digest', () => {
    const agg = /jsonb_agg\(jsonb_build_array\([^;]*?sii\.vat_classification\)\s*(ORDER BY [^)]*?sii\.id)\)/.exec(migration);
    expect(agg, 'the lines\' jsonb_agg ORDER BY was not found in 708').not.toBeNull();
    expect(squash(SUPPLIER_INVOICE_LINE_ORDER_BY)).toBe(squash(agg![1]!));
  });

  it('is a plain column list on the sii alias: created_at first, id last', () => {
    expect(SUPPLIER_INVOICE_LINE_ORDER_BY).toMatch(/^ORDER BY sii\.created_at, .*, sii\.id$/);
  });
});
