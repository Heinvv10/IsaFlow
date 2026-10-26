/**
 * Budgets P2 PR-B round 1: hostile uploads to POST budget-grid/import-preview and the template's
 * row cap (R3).
 *   - BRK-H2: shared-strings filler (breaker I5: 76 MB of <si> in a 0.2 MB upload, 86 s + 4 GB) is
 *     refused fast; the workbook is read in ONE pass under budget-specific limits; the file is
 *     validated before the read model loads.
 *   - QA-6: a corrupt zip that starts with PK is a 400, not a 500. SEC-L2: an impossible date cell
 *     is a cell error, not a 500. SEC-M1: errors are capped and echoed text is clipped.
 *   - Round 9 (R2): the upload is JSON `{ versionId, fileName?, fileData }` with the file as base64:
 *     other keys, a body that is not base64, a decoded file over MAX_FILE_BYTES are 400; the file
 *     never touches the disk (SEC-L1's temp files are gone with formidable). SEC-L5: refusal logs
 *     carry company and user. The version is confirmed before the file is parsed.
 *   - Round 2: hostile XML through the route (BRK2-N1/N4, SEC2-L3: deep nesting, a `<c>` with no
 *     `r`, a DOCTYPE) and a 23 MB styles part (BRK2-N6) are fast 400s with neutral messages;
 *     15 000 copies of one row (SEC2-M1) are grouped in linear time; Q5: previews are rate limited.
 *   (R3, the template's row cap, moved to budget-grid-template.int.test.ts with ruling Q1.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute, { MAX_FILE_BYTES } from '../../pages/api/accounting/budget-grid/import-preview';
import { log } from '@/lib/logger';
import { MAX_IMPORT_CELLS } from '@/modules/accounting/services/budgets/gridSaveValidate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { budgetSheet, col, downloadTemplate, editWorkbook, postPreview, rowOf, setCell, uploadPreview, withParts } from './helpers/budgetImportFixture';

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

  it('round 9: the version is checked before the file is: a corrupt file for another company\'s (or no) version is 404, unparsed', async () => {
    const corrupt = file.subarray(0, Math.floor(file.length / 2));
    const warn = vi.spyOn(log, 'warn');
    try {
      expect((await preview(corrupt, vB)).status).toBe(404);
      expect((await preview(corrupt, crypto.randomUUID())).status).toBe(404);
      expect(warn.mock.calls.filter(([m]) => /workbook refused|parser failed/i.test(String(m)))).toEqual([]); // never parsed
    } finally {
      warn.mockRestore();
    }
  });

  it('round 9: a version on a financial-year label the registry does not have is 404, not 500', async () => {
    // Label 1 belongs to no year (the read route answers it 404 too); the version row itself exists.
    const vC = await fx.version(A, { fy: 1, name: 'No year' });
    const r = await uploadPreview(previewRoute, A.owner, vC, file);
    expect([r.status, r.body.error?.message], JSON.stringify(r.body).slice(0, 300)).toEqual([404, expect.stringMatching(/financial year/i)]);
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
    const n = Math.min(15000, Math.floor(MAX_IMPORT_CELLS / 12) - 20); // under the import's row limit
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

  it('L2: a file with more row x month cells than one save holds is refused, in a 14-month year', async () => {
    const T = await fx.company({ transition: true });
    const vT = await fx.version(T, { name: 'Long year' });
    const t = await template(T, vT);
    expect(t.status).toBe(200);
    const n = Math.floor(MAX_IMPORT_CELLS / 14) + 1; // over the import's cap at 14 months, under the reader's row limit
    const long = await editWorkbook(t.file!, (wb) => {
      const ws = budgetSheet(wb);
      for (let i = 0; i < n; i++) ws.addRow(['Expenses', `Z${i}`, 'x', 1]);
    });
    const r = await uploadPreview(previewRoute, T.owner, vT, long);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(400);
    expect(r.body.error?.message).toMatch(new RegExp(`14 months.*${MAX_IMPORT_CELLS}|${MAX_IMPORT_CELLS}.*14 months`));
    expect((await uploadPreview(previewRoute, T.owner, vT, t.file!)).status).toBe(200);
  }, 300000);

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

describe('the upload itself (round 9: JSON, the file as base64)', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ versionId: v, fileName: 'budget.xlsx', fileData: file.toString('base64'), ...extra });

  it('the shape is enforced: an extra key, a missing file, a bad versionId are 400; the plain body is 200', async () => {
    expect((await postPreview(previewRoute, A.owner, body({ note: 'x' }))).status).toBe(400);
    expect((await postPreview(previewRoute, A.owner, { versionId: v })).status).toBe(400);
    expect((await postPreview(previewRoute, A.owner, body({ versionId: 'nope' }))).status).toBe(400);
    expect((await postPreview(previewRoute, A.owner, 'not an object')).status).toBe(400);
    expect((await postPreview(previewRoute, A.owner, body())).status).toBe(200);
  });

  it('fileData that is not standard base64 is 400; a decoded file over MAX_FILE_BYTES is 400', async () => {
    for (const fileData of ['not base64!', 'abc', `${file.toString('base64')}\n`, file.toString('base64url')]) {
      const r = await postPreview(previewRoute, A.owner, body({ fileData }));
      expect(r.status, fileData.slice(0, 20)).toBe(400);
    }
    const over = Buffer.alloc(MAX_FILE_BYTES + 1, 0x50).toString('base64');
    const r = await postPreview(previewRoute, A.owner, body({ fileData: over }));
    expect([r.status, r.body.error?.message]).toEqual([400, expect.stringMatching(/larger than 10 MB/)]);
  }, 60000);

  it('the request log never holds the file: fileData is logged as its size only', async () => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    let r;
    try {
      r = await postPreview(previewRoute, A.owner, body());
    } finally {
      process.stdout.write = write;
    }
    expect(r.status).toBe(200);
    const request = lines.filter((l) => l.includes('API Request: POST'));
    expect(request.length).toBeGreaterThan(0);
    expect(request.join('')).toMatch(/omitted: \d+ chars/);
    const sample = file.toString('base64').slice(200, 264);
    expect(lines.filter((l) => l.includes(sample))).toEqual([]);
  });

  it('an old .xls (by name or by its OLE signature) is 400', async () => {
    expect((await postPreview(previewRoute, A.owner, body({ fileName: 'budget.xls' }))).status).toBe(400);
    expect((await uploadPreview(previewRoute, A.owner, v, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])))).toMatchObject({ status: 400 });
  });

  it('the body limit is Next\'s parser at 14 MB, enough for a 10 MB file as base64', async () => {
    const { config } = await import('../../pages/api/accounting/budget-grid/import-preview');
    expect(config).toEqual({ api: { bodyParser: { sizeLimit: '14mb' } } });
    expect(Math.ceil(MAX_FILE_BYTES / 3) * 4).toBeLessThan(14 * MB);
  });

  it('Q5 / N5: previews are rate limited per user, across the user\'s companies (429)', async () => {
    const C = await fx.company();
    const D = await fx.company();
    const vC = await fx.version(C, { name: 'Rate' });
    const vD = await fx.version(D, { name: 'Rate' });
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', false)`, [D.id, C.owner.userId]);
    const junk = Buffer.from('PK\x03\x04 not a zip');
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await uploadPreview(previewRoute, C.owner, vC, junk)).status);
    for (let i = 0; i < 30; i++) statuses.push((await uploadPreview(previewRoute, { ...C.owner, homeCompanyId: D.id }, vD, junk)).status);
    expect(statuses.every((s) => s === 400)).toBe(true);
    // The 61st is refused before its file is decoded or parsed (no refusal log for it), 429 with
    // Retry-After. (Every member's bucket is removed by the fixture's cleanup.)
    const warn = vi.spyOn(log, 'warn');
    try {
      const last = await postPreview(previewRoute, { ...C.owner, homeCompanyId: D.id }, { versionId: vD, fileData: junk.toString('base64') });
      expect([last.status, last.headers.get('retry-after')]).toEqual([429, '900']);
      expect(warn.mock.calls.filter(([m]) => /budget import (upload|workbook) refused/i.test(String(m)))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 120000);

  it('SEC-L5: refusal logs name the company and the user', async () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      await preview(file.subarray(0, 100));
      await postPreview(previewRoute, A.owner, { versionId: v, fileData: 'not base64!' });
      const refusals = warn.mock.calls.filter(([message]) => /budget import/i.test(String(message)));
      expect(refusals.length).toBeGreaterThanOrEqual(2);
      for (const [, data] of refusals) expect(data).toMatchObject({ companyId: A.id, userId: A.owner.userId });
    } finally {
      warn.mockRestore();
    }
  });
});
