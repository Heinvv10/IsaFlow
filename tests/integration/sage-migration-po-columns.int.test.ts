/**
 * The compare of a re-run is only as complete as its column lists (sagePoContent): every column of `purchase_orders` and `po_items` must be
 * either COMPARED or EXCLUDED with a reason. A column added by a later migration is in neither list until someone decides, and this test
 * fails until they do. Also: the columns the PO tool WRITES are all compared or excluded (read from its own INSERT statements).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { PO_HEADER_COMPARED, PO_HEADER_EXCLUDED, PO_LINE_COMPARED, PO_LINE_EXCLUDED } from '@/modules/accounting/services/sage-migration/sagePoContent';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(async () => { await pool.end(); });

const columnsOf = async (table: string): Promise<string[]> =>
  (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`, [table])).rows.map((r) => String(r.column_name));

describe.each([
  ['purchase_orders', PO_HEADER_COMPARED, PO_HEADER_EXCLUDED],
  ['po_items', PO_LINE_COMPARED, PO_LINE_EXCLUDED],
] as const)('%s', (table, compared, excluded) => {
  it('every column is compared or excluded (with a reason), and every listed column exists', async () => {
    const actual = await columnsOf(table);
    const listed = [...compared, ...Object.keys(excluded)];
    expect(actual.filter((c) => !listed.includes(c)), `columns of ${table} in neither list of sagePoContent.ts: decide for each whether a re-run compares it`).toEqual([]);
    expect(listed.filter((c) => !actual.includes(c)), `columns listed in sagePoContent.ts that ${table} no longer has`).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('the columns the PO tool writes', () => {
  /** The column list of an INSERT INTO <table> (...) in the tool's writers. */
  const insertColumns = (file: string, table: string): string[] => {
    const m = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)`).exec(readFileSync(file, 'utf8'));
    expect(m, `${file} has an INSERT INTO ${table}`).not.toBeNull();
    return m![1]!.split(',').map((c) => c.trim()).filter(Boolean);
  };
  it('every column the PO import inserts into purchase_orders is compared or excluded', () => {
    const written = insertColumns('src/modules/accounting/services/ap/purchaseOrderImport.ts', 'purchase_orders');
    expect(written.length).toBeGreaterThan(10);
    expect(written.filter((c) => !(PO_HEADER_COMPARED as readonly string[]).includes(c) && !(c in PO_HEADER_EXCLUDED))).toEqual([]);
  });
  it('every column the PO line writer inserts into po_items is compared or excluded', () => {
    const written = insertColumns('src/modules/accounting/services/ap/purchaseOrderLinesWrite.ts', 'po_items');
    expect(written.length).toBeGreaterThan(10);
    expect(written.filter((c) => !(PO_LINE_COMPARED as readonly string[]).includes(c) && !(c in PO_LINE_EXCLUDED))).toEqual([]);
  });
});
