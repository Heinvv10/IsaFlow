/**
 * checkCodeDuplicate and the bulk upsert see a legacy item stored with surrounding whitespace ('FIB-0001 ', a tab, a
 * non-breaking space) as holding the trimmed code. Postgres btrim(code) strips only spaces while JS .trim() strips tabs,
 * CR/LF and NBSP, so the SQL side names the same set (itemCodeWhitespace). Real PG16, as the throwaway cluster applies the
 * migrations; the bulk upsert runs through the real registry as an item-scoped owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, cleanupWorld, itemsWorld, type ItemsWorld } from './helpers/itemsWorld';
import { text } from './helpers/mcpBudgetFixture';
import { checkCodeDuplicate } from '../../src/modules/accounting/services/items/itemService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

let w: ItemsWorld;
let company: string;
const ids: Record<string, string> = {};

const legacy = async (key: string, code: string): Promise<void> => {
  ids[key] = String((await pool.query(
    `INSERT INTO items (company_id, code, description) VALUES ($1, $2, $3) RETURNING id`, [company, code, `legacy ${key}`])).rows[0].id);
};

beforeAll(async () => {
  w = await itemsWorld(pool);
  company = w.a.u.homeCompanyId;
  await legacy('space', 'FIB-0001 ');
  await legacy('tab', 'FIB-0002\t');
  await legacy('nbsp', 'FIB-0003 ');
  await legacy('crlf', '\r\nFIB-0004');
  await legacy('clean', 'FIB-0005');
  await legacy('ideographic', 'FIB-0006\u3000');
  await legacy('narrow', '\u202fFIB-0007');
}, 120000);
afterAll(async () => {
  try { await cleanupWorld(pool, w); } finally { await pool.end(); }
}, 120000);

describe('checkCodeDuplicate against legacy untrimmed codes', () => {
  it.each(['FIB-0001', 'FIB-0002', 'FIB-0003', 'FIB-0004', 'FIB-0005', 'FIB-0006', 'FIB-0007'])('%s is held by an existing item', async (code) => {
    expect(await checkCodeDuplicate(company, code)).toBe(true);
  });

  it('an unrelated code is free, and another company never sees the row', async () => {
    expect(await checkCodeDuplicate(company, 'FIB-9999')).toBe(false);
    expect(await checkCodeDuplicate(w.b.u.homeCompanyId, 'FIB-0001')).toBe(false);
  });

  it('excluding the legacy row itself frees its own code, but not another row\'s', async () => {
    expect(await checkCodeDuplicate(company, 'FIB-0001', ids.space)).toBe(false);
    expect(await checkCodeDuplicate(company, 'FIB-0002', ids.tab)).toBe(false);
    expect(await checkCodeDuplicate(company, 'FIB-0001', ids.tab)).toBe(true);
  });
});

describe('bulk_upsert_items against a legacy untrimmed code', () => {
  const upsert = async (items: Array<Record<string, unknown>>, dry_run: boolean) =>
    JSON.parse(text(await as(pool, w.a).run('bulk_upsert_items', { items, dry_run })));
  const count = async (): Promise<number> => Number((await pool.query('SELECT count(*) AS n FROM items WHERE company_id = $1', [company])).rows[0].n);

  it('refuses the trimmed code in a dry run and live alike, creating nothing', async () => {
    const before = await count();
    for (const dry of [true, false]) {
      const out = await upsert([{ code: 'FIB-0001', description: 'new one' }, { code: 'FIB-0002', description: 'new two' }], dry) as { refusals?: Array<{ index: number; code: string; reason: string }> };
      expect(out.refusals?.map((r) => [r.index, r.code])).toEqual([[0, 'code_held_with_whitespace'], [1, 'code_held_with_whitespace']]);
      expect(out.refusals?.[0]?.reason).toMatch(/surrounding whitespace/);
    }
    expect(await count()).toBe(before);
  });

  it('still creates a genuinely new code', async () => {
    const out = await upsert([{ code: 'FIB-7777', description: 'fresh' }], false) as { refusals?: unknown[] };
    expect(out.refusals ?? []).toEqual([]);
    expect((await pool.query('SELECT 1 FROM items WHERE company_id = $1 AND code = $2', [company, 'FIB-7777'])).rowCount).toBe(1);
  });
});
