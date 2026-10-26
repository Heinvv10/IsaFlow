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
 *   - Round 2: hostile XML through the route (BRK2-N1/N4, SEC2-L3: deep nesting, a `<c>` with no
 *     `r`, a DOCTYPE) and a 23 MB styles part (BRK2-N6) are fast 400s with neutral messages;
 *     15 000 copies of one row (SEC2-M1) are grouped in linear time; Q5: previews are rate limited.
 *   (R3, the template's row cap, moved to budget-grid-template.int.test.ts with ruling Q1.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import { log } from '@/lib/logger';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSaveValidate';
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

describe('round 2: hostile XML and styles through the route', () => {
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const sheetXml = (rows: string) => `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;
  it.each([
    ['breaker U1: 3M unclosed tags in the Budget sheet', 'xl/worksheets/sheet1.xml', () => sheetXml(`<row r="1">${'<x>'.repeat(3_000_000)}`)],
    ['breaker U1: <c> without r', 'xl/worksheets/sheet1.xml', () => sheetXml(`<row r="1">${'<c><v>1</v></c>'.repeat(50)}</row>`)],
    ['breaker U1: a DOCTYPE entity in shared strings', 'xl/sharedStrings.xml', () => `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa">]><sst ${NS}><si><t>&a;</t></si></sst>`],
    ['BRK2-N6: 23 MB of <font> in styles.xml', 'xl/styles.xml', () => `<?xml version="1.0"?><styleSheet ${NS}><fonts>${'<font><b/><sz val="11"/></font>'.repeat(Math.floor((23 * MB) / 32))}</fonts></styleSheet>`],
  ])('%s is a fast 400 that echoes no parser text', async (_label, part, xml) => {
    const bad = await withParts(file, { [part]: xml() });
    const { ms, out } = await timed(() => preview(bad));
    expect(out.status, JSON.stringify(out.body).slice(0, 300)).toBe(400);
    expect(out.body.error?.message).not.toMatch(/\d+:\d+|entity|undefined|properties/);
    expect(ms).toBeLessThan(5000);
  }, 120000);
});

describe('cell and row refusals stay cell and row errors', () => {
  it('SEC2-M1: 15 000 copies of one row are grouped in linear time; each error names a few other rows', async () => {
    const n = Math.min(15000, Math.floor(MAX_SAVE_CELLS / 12) - 20); // under the import's row limit
    const copies = await editWorkbook(file, (wb) => {
      const ws = budgetSheet(wb);
      for (let i = 0; i < n; i++) ws.addRow(['Revenue', '4000', 'Sales', i]);
    });
    const { ms, out } = await timed(() => preview(copies));
    expect(out.status).toBe(200);
    const p = out.body.data as unknown as { errors: Array<{ message: string }>; errorCount: number };
    expect(p.errorCount).toBeGreaterThanOrEqual(n);
    expect(Math.max(...p.errors.map((e) => e.message.length))).toBeLessThan(200);
    expect(ms).toBeLessThan(4000);
  }, 120000);

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

  it('Q5: previews are rate limited per member (429)', async () => {
    const C = await fx.company();
    const vC = await fx.version(C, { name: 'Rate' });
    const junk = Buffer.from('PK\x03\x04 not a zip');
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await uploadPreview(previewRoute, C.owner, vC, junk)).status);
    expect(statuses.slice(0, 60).every((s) => s === 400)).toBe(true);
    expect(statuses[60]).toBe(429);
  }, 120000);

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
