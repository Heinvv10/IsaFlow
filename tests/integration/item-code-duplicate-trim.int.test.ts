/**
 * checkCodeDuplicate sees a legacy item stored with surrounding whitespace ('FIB-0001 ', a tab, a
 * non-breaking space) as holding the trimmed code. Postgres btrim(code) strips only spaces while JS .trim() strips tabs,
 * CR/LF and NBSP, so the SQL side names the same set (itemCodeWhitespace). Real PG16, as the throwaway cluster applies the
 * migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld, itemsWorld, type ItemsWorld } from './helpers/itemsWorld';
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
}, 120000);
afterAll(async () => {
  try { await cleanupWorld(pool, w); } finally { await pool.end(); }
}, 120000);

describe('checkCodeDuplicate against legacy untrimmed codes', () => {
  it.each(['FIB-0001', 'FIB-0002', 'FIB-0003', 'FIB-0004', 'FIB-0005'])('%s is held by an existing item', async (code) => {
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
