/**
 * Budgets P2 PR-B round 4, U8, through the real routes: account and member codes with 2-, 3- and
 * 4-byte UTF-8 characters round-trip template -> import with no error and no change, and the signed
 * `_base` still verifies, when the character sits exactly across a piece boundary of the zip the
 * budget reader feeds ExcelJS (styles.xml, which precedes the shared strings, is padded with a
 * comment to put it there). Before the fix the character came back as U+FFFD: the code matched
 * nothing and `_base` failed its signature.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import JSZip from 'jszip';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import { normaliseXlsxSheets } from '@/lib/xlsxNormalise';
import { READ_CHUNK_BYTES } from '@/lib/xlsxXmlScan';
import { BUDGET_IMPORT_LIMITS } from '@/modules/accounting/services/budgets/budgetImportParse';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { budgetSheet, downloadTemplate, editWorkbook, setCell, uploadPreview } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const CODES = { 'é': 'Sé01', '⛽': 'F⛽02', '🚚': 'T🚚03' } as const;
let A: GridCo, v: string, member: string;
const ids: Record<string, string> = {};

async function withStylesComment(file: Buffer, length: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(file);
  const styles = await zip.file('xl/styles.xml')!.async('string');
  const at = styles.indexOf('?>') + 2;
  zip.file('xl/styles.xml', `${styles.slice(0, at)}<!--${'x'.repeat(length)}-->${styles.slice(at)}`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** `file` padded so the first byte of `char` in the budget reader's normalised zip is one byte before a piece boundary. */
async function straddling(file: Buffer, char: string): Promise<Buffer> {
  const bytes = Buffer.from(char);
  const offset = async (f: Buffer) => (await normaliseXlsxSheets(f, ['_meta', '_base', 'Budget'], { maxBytes: BUDGET_IMPORT_LIMITS.maxUncompressedBytes })).zip.indexOf(bytes);
  const base = await offset(await withStylesComment(file, 0));
  let target = Math.ceil((base + 1) / READ_CHUNK_BYTES) * READ_CHUNK_BYTES - 1;
  if (target - base < 1) target += READ_CHUNK_BYTES;
  const padded = await withStylesComment(file, target - base);
  expect(await offset(padded)).toBe(target);
  return padded;
}

beforeAll(async () => {
  A = await fx.company();
  for (const [char, code] of Object.entries(CODES)) {
    ids[code] = String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, $2, $3, 'expense', 'debit', 3, true) RETURNING id`, [A.id, code, `Fuel ${char} and Société Générale`])).rows[0].id);
  }
  member = String((await pool.query(
    `INSERT INTO cost_centres (company_id, code, name, cc_type, is_active) VALUES ($1, 'Mé⛽🚚', 'Dépôt ⛽ 🚚', 'cc1', true) RETURNING id`, [A.id])).rows[0].id);
  v = await fx.version(A, { name: 'UTF-8' });
  await fx.amounts(A, v, ids['Sé01']!, FY27, 10, { cc1: member });
}, 120000);

afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

describe('U8: non-ASCII codes across a piece boundary', () => {
  it.each(Object.entries(CODES))('%s at company and CC1 grain: no error, no change, _base verifies; an edit lands on its row', async (char, code) => {
    for (const grain of ['company', 'cc1'] as const) {
      const t = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain, ...(grain === 'cc1' ? { members: member } : {}) });
      expect(t.status).toBe(200);
      const padded = await straddling(t.file!, char);
      const r = await uploadPreview(previewRoute, A.owner, v, padded);
      expect(r.status, `${grain} ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
      const p = r.body.data as unknown as { changes: unknown[]; errors: unknown[] };
      expect(p.errors, grain).toEqual([]);
      expect(p.changes, grain).toEqual([]);
      if (grain === 'company' && code === 'Sé01') continue; // Sé01 is budgeted by CC1, so the company template does not offer it
      const edited = await straddling(await editWorkbook(padded, (wb) => setCell(budgetSheet(wb), code, FY27[1]!, 7, grain === 'cc1' ? 'Mé⛽🚚' : undefined)), char);
      const e = await uploadPreview(previewRoute, A.owner, v, edited);
      expect(e.status, JSON.stringify(e.body).slice(0, 300)).toBe(200);
      expect((e.body.data as unknown as { changes: Array<{ key: string }> }).changes.map((c) => c.key))
        .toEqual([`${ids[code]}|${grain === 'cc1' ? member : ''}|||${FY27[1]}`]);
    }
  }, 120000);
});
