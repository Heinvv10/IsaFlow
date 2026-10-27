/**
 * Budgets P2 PR-B round 3, N1: the stricter XML scan (element names matched, attributes checked)
 * and the chunked parser feed must not refuse a real template re-saved by another spreadsheet
 * program. The template is downloaded through the route, re-saved by LibreOffice
 * (`soffice --headless --convert-to xlsx`, its own profile so parallel runs do not share a lock),
 * and previewed: no refusal, no error, no change (invariant 3), the signed `_base` still verifies;
 * an edit after the re-save is the one change. Codes that start with a formula character, an
 * apostrophe or end in a space are in the chart, at company and CC1 grain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import JSZip from 'jszip';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { budgetSheet, downloadTemplate, editWorkbook, setCell, uploadPreview } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const SOFFICE = ['/usr/bin/soffice', '/usr/bin/libreoffice'].find((p) => fs.existsSync(p));

let A: GridCo, v: string, work: string;

/** `file` re-saved by LibreOffice as .xlsx. */
function libreOffice(file: Buffer, name: string): Buffer {
  const dir = fs.mkdtempSync(path.join(work, `${name}-`));
  const src = path.join(dir, 'in', `${name}.xlsx`);
  fs.mkdirSync(path.dirname(src));
  fs.writeFileSync(src, file);
  execFileSync(SOFFICE!, [`-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--headless', '--convert-to', 'xlsx', '--outdir', path.join(dir, 'out'), src],
    { timeout: 180000, stdio: 'ignore' });
  return fs.readFileSync(path.join(dir, 'out', `${name}.xlsx`));
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-lo-'));
  A = await fx.company();
  for (const code of ['=1+2', "'7300", '7000 ']) {
    await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active) VALUES ($1, $2, $3, 'expense', 'debit', 3, true)`, [A.id, code, `-Odd ${code}`]);
  }
  v = await fx.version(A, { name: 'LibreOffice' });
  await fx.amounts(A, v, A.acct.sales, FY27, 1234.56);
  await fx.amounts(A, v, A.acct.cos, FY27.slice(0, 6), 0);
  await fx.amounts(A, v, A.acct.rent, FY27, 100, { cc1: A.cc1 });
}, 120000);

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}, 120000);

// ci-integration-skip: needs LibreOffice (soffice) on the runner; skipped where it is not installed.
describe.skipIf(!SOFFICE)('N1: a template re-saved by LibreOffice imports', () => {
  it.each(['company', 'cc1'])('at %s grain: no refusal, no error, no change; an edit after the re-save is the one change', async (grain) => {
    const t = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain, ...(grain === 'cc1' ? { members: `${A.cc1},${A.cc1b}` } : {}) });
    expect(t.status).toBe(200);
    const resaved = libreOffice(t.file!, grain);
    expect(await (await JSZip.loadAsync(resaved)).file('docProps/app.xml')!.async('string')).toMatch(/LibreOffice/);
    const r = await uploadPreview(previewRoute, A.owner, v, resaved);
    expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
    const p = r.body.data as unknown as { changes: unknown[]; errors: unknown[]; warnings: Array<{ message: string }> };
    expect(p.errors).toEqual([]);
    expect(p.changes).toEqual([]);
    const edited = await editWorkbook(resaved, (wb) => setCell(budgetSheet(wb), grain === 'cc1' ? '6000' : '4000', FY27[1]!, 99, grain === 'cc1' ? 'GC1' : undefined));
    const e = await uploadPreview(previewRoute, A.owner, v, edited);
    expect(e.status, JSON.stringify(e.body).slice(0, 400)).toBe(200);
    expect((e.body.data as unknown as { changes: unknown[] }).changes).toHaveLength(1);
  }, 400000);
});
