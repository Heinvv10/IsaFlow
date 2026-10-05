/**
 * deploy.sh runs scripts/audit-schema-drift.ts right after the migrations,
 * and the audit fails the deploy for any table the migrations still declare
 * but the database lacks. Its model comes from the migration text
 * (scripts/lib/schemaDriftParse.ts), so a table dropped by a statement built
 * at runtime stays "expected" and every deploy after the drop fails.
 * Migration 855 must therefore drop the archive tables literally.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExpectedSchema } from '../../../scripts/lib/schemaDriftParse';

const ARCHIVE_TABLES = [
  'archive_gl_journal_entries', 'archive_gl_journal_lines', 'archive_bank_transactions',
  'archive_customer_invoices', 'archive_supplier_invoices', 'archive_runs',
];

describe('schema-drift model after migration 855', () => {
  it('expects none of the dropped archive tables', () => {
    const expected = parseExpectedSchema();
    expect(ARCHIVE_TABLES.filter(t => expected.has(t))).toEqual([]);
    expect(expected.has('customer_invoices')).toBe(true); // the model itself still loaded
  });

  it('a literal DROP TABLE inside a DO block removes the table from the model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-parse-'));
    try {
      writeFileSync(join(dir, '001_create.sql'), 'CREATE TABLE IF NOT EXISTS b_t (id uuid);\n');
      writeFileSync(join(dir, '002_drop.sql'), 'DO $$ BEGIN DROP TABLE IF EXISTS public.b_t; END $$;\n');
      expect(parseExpectedSchema(dir).has('b_t')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
