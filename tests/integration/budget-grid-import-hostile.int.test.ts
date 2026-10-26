/**
 * Budgets P2 PR-B round 1: hostile uploads to POST budget-grid/import-preview and the template's
 * row cap (R3).
 *   - BRK-H2: shared-strings filler (breaker I5: 76 MB of <si> in a 0.2 MB upload, 86 s + 4 GB) is
 *     refused fast; the workbook is read in ONE pass under budget-specific limits; the file is
 *     validated before the read model loads.
 *   - QA-6: a corrupt zip that starts with PK is a 400, not a 500. SEC-L2: an impossible date cell
 *     is a cell error, not a 500. SEC-M1: errors are capped and echoed text is clipped.
 *   - SEC-L1: every uploaded temp file is removed, whatever field it came in on, and on refusal.
 *     SEC-L3: few, small fields. SEC-L5: refusal logs carry company and user.
 *   - R3: a template past the import's row limit is refused; one at the limit round-trips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import { log } from '@/lib/logger';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { budgetSheet, col, downloadTemplate, editWorkbook, rowOf, setCell, uploadParts, uploadPreview, withParts } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const MB = 1024 * 1024;

let A: GridCo, B: GridCo, v: string, vB: string, file: Buffer;

async function template(c: GridCo, versionId: string, grain = 'company') {
  return downloadTemplate(templateRoute, c.owner, { version_id: versionId, grain });
}
const preview = (f: Buffer, versionId = v) => uploadPreview(previewRoute, A.owner, versionId, f);
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; out: T }> {
  const t0 = Date.now();
  const out = await fn();
  return { ms: Date.now() - t0, out };
}

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  v = await fx.version(A, { name: 'Hostile' });
  vB = await fx.version(B, { name: 'B' });
  const t = await template(A, v);
  expect(t.status).toBe(200);
  file = t.file!;
}, 120000);

afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 300000);

describe('BRK-H2: one bounded pass', () => {
  it('breaker I5: 76 MB of shared-string filler is refused fast', async () => {
    const filler = '<si><t>x</t></si>'.repeat(Math.floor((76 * MB) / 17));
    const bomb = await withParts(file, { 'xl/sharedStrings.xml': (xml) => xml.replace('</sst>', `${filler}</sst>`) });
    const { ms, out } = await timed(() => preview(bomb));
    expect(out.status, JSON.stringify(out.body).slice(0, 300)).toBe(400);
    expect(out.body.error?.message).toMatch(/text/i);
    expect(ms).toBeLessThan(10000);
  }, 120000);

  it('too many shared-string entries is refused, under the byte cap', async () => {
    const many = await withParts(file, { 'xl/sharedStrings.xml': (xml) => xml.replace('</sst>', `${'<si/>'.repeat(200000)}</sst>`) });
    const r = await preview(many);
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/different texts/i);
  }, 60000);

  it('the file is checked before the version is: a corrupt file for another company\'s version is 400', async () => {
    const corrupt = file.subarray(0, Math.floor(file.length / 2));
    expect((await preview(corrupt, vB)).status).toBe(400);
  });

  it('QA-6: a corrupt zip that starts with PK is a 400', async () => {
    const r = await preview(file.subarray(0, Math.floor(file.length / 2)));
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(400);
    expect(r.body.error?.message).toMatch(/workbook|damaged/i);
  });
});

describe('cell and row refusals stay cell and row errors', () => {
  it('SEC-L2: a date cell no calendar holds is a cell error, not a 500', async () => {
    const bad = await editWorkbook(file, (wb) => {
      const ws = budgetSheet(wb);
      setCell(ws, '4000', '2026-03', 1e10);
      ws.getRow(rowOf(ws, '4000')).getCell(col(ws, '2026-03')).numFmt = 'yyyy-mm-dd';
    });
    const r = await preview(bad);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const errors = (r.body.data as unknown as { errors: Array<{ column: string; message: string }> }).errors;
    expect(errors).toEqual([expect.objectContaining({ column: '2026-03', message: expect.stringMatching(/date|amount/i) })]);
  });

  it('SEC-M1: errors are capped at 200 with the full count, and echoed text is clipped', async () => {
    const long = `X${'9'.repeat(5000)}`;
    const many = await editWorkbook(file, (wb) => {
      const ws = budgetSheet(wb);
      for (let i = 0; i < 300; i++) ws.addRow(['Expenses', `${long}${i}`, 'x', 5]);
    });
    const r = await preview(many);
    expect(r.status).toBe(200);
    const p = r.body.data as unknown as { errors: Array<{ message: string }>; errorCount: number; truncated: boolean };
    expect(p.errors).toHaveLength(200);
    expect(p.errorCount).toBe(300);
    expect(p.truncated).toBe(true);
    expect(Math.max(...p.errors.map((e) => e.message.length))).toBeLessThan(200);
  }, 60000);
});

describe('the upload itself', () => {
  /** Uploaded temp files still holding `marker`, made since `since`: in the temp dir, or one directory down. */
  function leftovers(marker: Buffer, since: number): string[] {
    const dir = os.tmpdir();
    const recent = (p: string) => { try { return fs.statSync(p).mtimeMs >= since - 1000; } catch { return false; } };
    const below = fs.readdirSync(dir).map((n) => path.join(dir, n)).filter(recent);
    const all = below.flatMap((p) => { try { return fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((n) => path.join(p, n)) : [p]; } catch { return []; } });
    return all.filter((p) => {
      try {
        const st = fs.statSync(p);
        return st.isFile() && st.size >= marker.length && st.size < 12 * MB && fs.readFileSync(p).includes(marker);
      } catch {
        return false; // removed while we looked
      }
    });
  }
  const marked = (size = 64) => {
    const marker = Buffer.from(`budget-import-leak-${crypto.randomUUID()}`);
    return { marker, content: Buffer.concat([Buffer.from('PK\x03\x04'), marker, Buffer.alloc(Math.max(0, size - marker.length - 4), 0x20)]) };
  };

  it.each([
    ['a file under another field name', 'other', 1, 64],
    ['two files', 'file', 2, 64],
    ['a file over 10 MB', 'file', 1, 10 * MB + 1024],
  ])('SEC-L1: %s leaves no temp file', async (_label, field, count, size) => {
    const since = Date.now();
    const { marker, content } = marked(size);
    const files = Array.from({ length: count }, () => ({ file: field, content }));
    const r = await uploadParts(previewRoute, A.owner, [{ field: 'versionId', value: v }, ...files]);
    expect(r.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(leftovers(marker, since)).toEqual([]);
  }, 60000);

  it('SEC-L3: extra fields, or a large one, are refused', async () => {
    const extra = Array.from({ length: 5 }, (_, i) => ({ field: `f${i}`, value: 'x' }));
    expect((await uploadParts(previewRoute, A.owner, [{ field: 'versionId', value: v }, ...extra, { file: 'file', content: file }])).status).toBe(400);
    expect((await uploadParts(previewRoute, A.owner, [{ field: 'versionId', value: v }, { field: 'note', value: 'x'.repeat(5000) }, { file: 'file', content: file }])).status).toBe(400);
    expect((await uploadParts(previewRoute, A.owner, [{ field: 'versionId', value: v }, { file: 'file', content: file }])).status).toBe(200);
  });

  it('SEC-L5: refusal logs name the company and the user', async () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      await preview(file.subarray(0, 100));
      await uploadParts(previewRoute, A.owner, [{ field: 'versionId', value: v }, ...Array.from({ length: 5 }, (_, i) => ({ field: `f${i}`, value: 'x' }))]);
      const refusals = warn.mock.calls.filter(([message]) => /budget import/i.test(String(message)));
      expect(refusals.length).toBeGreaterThanOrEqual(2);
      for (const [, data] of refusals) expect(data).toMatchObject({ companyId: A.id, userId: A.owner.userId });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('R3: the template never has more rows than the import reads', () => {
  let Big: GridCo, vBig: string;
  beforeAll(async () => {
    Big = await fx.company();
    await pool.query(`UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND id <> $2`, [Big.id, Big.acct.sales]);
    // GC1 and GC1B are active already: 14 999 more is 15 001 CC1 rows.
    await pool.query(
      `INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active)
       SELECT gen_random_uuid(), $1, 'M' || lpad(g::text, 5, '0'), 'Member ' || g, 'cc1', true FROM generate_series(1, 14999) g`, [Big.id]);
    vBig = await fx.version(Big, { name: 'Big' });
  }, 300000);

  it('refuses a template one row past the limit', async () => {
    const r = await template(Big, vBig, 'cc1');
    expect(r.status).toBe(400);
    expect(r.json?.error?.message).toMatch(/15 ?001 rows.*15 ?000/);
  }, 120000);

  it('a filled template at the limit round-trips with no change', async () => {
    await pool.query(`UPDATE cost_centres SET is_active = false WHERE company_id = $1 AND code = 'M00001'`, [Big.id]);
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
       SELECT $1, $2, $3, m::date, 123456.78, cc.id
         FROM cost_centres cc CROSS JOIN generate_series('2026-03-01'::date, '2027-02-01'::date, interval '1 month') m
        WHERE cc.company_id = $1 AND cc.cc_type = 'cc1' AND cc.is_active`, [Big.id, vBig, Big.acct.sales]);
    const t = await template(Big, vBig, 'cc1');
    expect(t.status, JSON.stringify(t.json).slice(0, 300)).toBe(200);
    const r = await uploadPreview(previewRoute, Big.owner, vBig, t.file!);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const p = r.body.data as unknown as { changes: unknown[]; errors: unknown[]; counts: { unchanged: number } };
    expect(p.errors).toEqual([]);
    expect(p.changes).toEqual([]);
    expect(p.counts.unchanged).toBe(15000 * 12);
  }, 600000);
});
