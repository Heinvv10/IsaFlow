/**
 * Wave 6 EFa through the real routes (withAuth, CSRF, write access) on real PostgreSQL, two companies: the filing file is
 * built from the finalised version, never the live payroll or ledger; its first download stamps the version (sha256 of
 * the capture CSV, kind, who) with an audit row; Mark filed needs that stamp and a PRN-shaped reference; every refusal
 * (no file, bad reference, wrong role, Login-as, another company, wrong format, superseded) changes no row.
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, loginAsToken, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { amendV, CLEAN, fileV, fin, genFile, PRN, row, submissions, useFixture, versionOf } from './helpers/returnFileCalls';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import filingFile from '../../pages/api/accounting/sars/returns/[form]/filing-file';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
let b: ReturnFixture;
const SEPT = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
const sha = (body: unknown) => createHash('sha256').update(body as Buffer).digest('hex');
const stampOf = async (id: string) => {
  const r = await row(id);
  return { sha: r.filing_file_sha256, kind: r.filing_file_kind, by: r.filing_file_by, at: r.filing_file_at, status: r.status };
};

describeIfDb('EFa: filing files through the routes', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, pay runs, submissions and return versions.');
    a = await seedReturnFixture('EFR', DATABASE_URL!);
    b = await seedReturnFixture('EFR2', DATABASE_URL!);
    useFixture(a);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
    if (b) await dropReturnFixture(b);
  }, 120000);

  it('EMP201: refusals change nothing; the download stamps the version from its own figures; the live payroll moving does not change the file; then it files', async () => {
    await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, total_uif,
      total_sdl, total_eti, employee_count, approved_at) VALUES (${a.fx.companyId}::UUID, 2026, 9, 'approved', 50000, 9000, 500, 500, 0,
      1, '2026-09-30T10:00:00Z')`;
    const e = versionOf(await callRoute(finalise, a.fx.companyId, a.admin.token, 'POST', { form: 'emp201' }, SEPT));
    const id = String(e.id);
    const subs = await submissions();
    const blank = await stampOf(id);
    expect(blank).toMatchObject({ sha: null, kind: null, by: null, status: 'finalised' });

    // Mark filed without the file: 409, nothing written (the service; the trigger holds the same, w6-efa-filing-file-db).
    const noFile = await fileV(id, { withoutFile: true }, a.admin.token, 'emp201');
    expect(noFile.status).toBe(409);
    expect(JSON.stringify(noFile.body)).toMatch(/FILING_FILE_REQUIRED/);
    // Refused downloads: manager, Login-as, the other company, a format the EMP201 has not got.
    expect((await genFile(id, 'emp201', 'csv', a.manager.token)).status).toBe(403);
    expect((await genFile(id, 'emp201', 'csv', await loginAsToken(a))).status).toBe(403);
    expect((await callRoute(filingFile, b.fx.companyId, b.admin.token, 'POST', { form: 'emp201' }, { versionId: id, format: 'csv' })).status).toBe(404);
    expect((await genFile(id, 'emp201', 'json')).status).toBe(400);
    expect((await genFile(id, 'vat201', 'csv')).status).toBe(404); // the wrong form
    expect(await stampOf(id)).toEqual(blank);
    expect(await submissions()).toBe(subs);

    const first = await genFile(id, 'emp201', 'csv');
    expect(first.status).toBe(200);
    const csv = (first.body as unknown as Buffer).toString('utf8');
    expect(csv).toContain('"Payroll tax calculations","PAYE",9000.00');
    const stamp = await stampOf(id);
    expect(stamp).toMatchObject({ sha: sha(first.body), kind: 'emp201_capture_csv', by: a.admin.userId, status: 'finalised' });
    const trail = (await sql`SELECT changes FROM audit_log WHERE company_id = ${a.fx.companyId}::UUID AND entity_id = ${id}::UUID
      AND changes #>> '{fields,0,field}' = 'filing_file_sha256'`) as Row[];
    expect(trail).toHaveLength(1);
    expect(JSON.stringify(trail[0]!.changes)).toContain(String(stamp.sha));

    // The live payroll moves: the file is the version's, unchanged, and the stamp stays.
    await sql`UPDATE payroll_run_headers SET total_paye = 9100 WHERE company_id = ${a.fx.companyId}::UUID AND period_month = 9`;
    const again = await genFile(id, 'emp201', 'csv');
    expect(sha(again.body)).toBe(stamp.sha);
    const pdf = await genFile(id, 'emp201', 'pdf');
    expect(pdf.status).toBe(200);
    expect((pdf.body as unknown as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await stampOf(id)).toEqual(stamp);
    await sql`UPDATE payroll_run_headers SET total_paye = 9000 WHERE company_id = ${a.fx.companyId}::UUID AND period_month = 9`;

    // A reference that is not an EMP201 PRN: 400, nothing written. Then it files.
    for (const bad of ['REF-1', PRN('vat201'), `${PRN('emp201')}9`, `${PRN('emp201').slice(0, 10)} L00000001`]) {
      expect((await fileV(id, { reference: bad, withoutFile: true }, a.admin.token, 'emp201')).status, bad).toBe(400);
    }
    expect(await submissions()).toBe(subs);
    const filed = await fileV(id, { reference: ` ${PRN('emp201').toLowerCase()} `, withoutFile: true }, a.admin.token, 'emp201');
    expect(filed.status).toBe(200);
    expect(await stampOf(id)).toEqual({ ...stamp, status: 'filed' });
    expect((await row(id)).filed_reference).toBe(PRN('emp201'));
    // After filing the file still downloads, unchanged and unstamped again.
    expect(sha((await genFile(id, 'emp201', 'csv')).body)).toBe(stamp.sha);
    expect(await stampOf(id)).toEqual({ ...stamp, status: 'filed' });
  });

  it('VAT201: the JSON names the stamped capture sheet; a superseded version has no file (409)', async () => {
    const v = versionOf(await fin(CLEAN));
    const id = String(v.id);
    const json = await genFile(id, 'vat201', 'json');
    expect(json.status).toBe(200);
    const body = JSON.parse((json.body as unknown as Buffer).toString('utf8')) as Row;
    const stamp = await stampOf(id);
    expect(stamp).toMatchObject({ kind: 'vat201_capture_csv', by: a.admin.userId });
    expect(body.captureSheetSha256).toBe(stamp.sha);
    expect(sha((await genFile(id, 'vat201', 'csv')).body)).toBe(stamp.sha);
    expect((await genFile(id, 'vat201', 'pdf')).status).toBe(400);
    expect((await amendV(id)).status).toBe(200);
    expect((await genFile(id, 'vat201', 'csv')).status).toBe(409);
    expect(await stampOf(id)).toEqual({ ...stamp, status: 'superseded' });
  });
});
