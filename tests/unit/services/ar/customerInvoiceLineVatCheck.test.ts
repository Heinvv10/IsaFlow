/**
 * Migration 1008's CHECK on customer_invoice_items.vat_type is the ledger's VatType list, both ways: a type the code
 * may post that the column refuses would fail the write at run time, and a spelling the column admits that no code
 * knows would post an uncoded claim. The migration cannot import the union, so this reads its text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VAT_TYPES } from '@/modules/accounting/services/shared/vatTypes';

const migration = readFileSync(path.join(process.cwd(), 'scripts/migrations/sql/1008_customer_invoice_line_vat.sql'), 'utf8');

function checkList(): string[] {
  const m = /ADD CONSTRAINT customer_invoice_items_vat_type_check\s+CHECK \(vat_type IS NULL OR vat_type IN \(([^)]*)\)\)/
    .exec(migration);
  expect(m, 'the vat_type CHECK was not found in 1008').not.toBeNull();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('migration 1008 vat_type CHECK', () => {
  it('lists exactly the VatType union', () => {
    expect([...checkList()].sort()).toEqual([...VAT_TYPES].sort());
  });

  it('lists each type once', () => {
    expect(new Set(checkList()).size).toBe(checkList().length);
  });

  it('pairs vat_type with tax_amount and bounds amounts_are', () => {
    expect(migration).toMatch(/CHECK \(\(vat_type IS NULL\) = \(tax_amount IS NULL\)\)/);
    expect(migration).toMatch(/CHECK \(amounts_are IS NULL OR amounts_are IN \('exclusive', 'inclusive'\)\)/);
  });
});
