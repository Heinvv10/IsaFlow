/**
 * Migration 1024's CHECK on customer_quote_lines.vat_type is the ledger's VatType list, both ways (as 1008's on
 * customer_invoice_items): a converted quote line's type must be one the invoice column admits, and a spelling the
 * column admits that no code knows would convert to an uncoded claim. The migration cannot import the union, so this
 * reads its text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VAT_TYPES } from '@/modules/accounting/services/shared/vatTypes';

const migration = readFileSync(path.join(process.cwd(), 'scripts/migrations/sql/1024_customer_quote_line_vat.sql'), 'utf8');

function checkList(): string[] {
  const m = /ADD CONSTRAINT customer_quote_lines_vat_type_check\s+CHECK \(vat_type IS NULL OR vat_type IN \(([^)]*)\)\)/
    .exec(migration);
  expect(m, 'the vat_type CHECK was not found in 1024').not.toBeNull();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('migration 1024 vat_type CHECK', () => {
  it('lists exactly the VatType union', () => {
    expect([...checkList()].sort()).toEqual([...VAT_TYPES].sort());
  });

  it('lists each type once', () => {
    expect(new Set(checkList()).size).toBe(checkList().length);
  });

  it('pairs vat_type with tax_amount and bounds amounts_are', () => {
    expect(migration).toMatch(/customer_quote_lines_vat_type_tax_amount_pair\s+CHECK \(\(vat_type IS NULL\) = \(tax_amount IS NULL\)\)/);
    expect(migration).toMatch(/customer_quotes_amounts_are_check\s+CHECK \(amounts_are IS NULL OR amounts_are IN \('exclusive', 'inclusive'\)\)/);
  });

  it('adds nullable columns only (old code keeps writing NULL)', () => {
    for (const col of ['customer_quote_lines ADD COLUMN IF NOT EXISTS vat_type TEXT NULL',
      'customer_quote_lines ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(15,2) NULL',
      'customer_quotes ADD COLUMN IF NOT EXISTS amounts_are TEXT NULL']) {
      expect(migration).toContain(col);
    }
    expect(migration).not.toMatch(/\bUPDATE\b/);
  });
});
