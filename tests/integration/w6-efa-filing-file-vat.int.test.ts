/**
 * Wave 6 EFa round 1 through the real routes on real PostgreSQL, a company with a VAT journal in the period:
 *  - finalise records IsaFlow's SARS form (figures.sarsForm) and the drawer, read straight after, shows NO drift (the
 *    false "SARS form boxes changed": jsonb reorders the stored boxes' keys); a journal posted afterwards IS drift;
 *  - the VAT201 sheet is that form field for field; a version without it has no sheet (409), nothing written;
 *  - the stored file is served as stored: after the generator's output changes, a stamped version re-downloads the
 *    same bytes and sha256 (the JSON too), while an unstamped one gets the new output;
 *  - the PRN must carry the company's own VAT number and is refused when another period's return already has it;
 *  - EMP201 versions (payroll figures) are refused to a viewer; VAT201 versions are not.
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { fileV, fin, genFile, PRN, row, useFixture, versionOf } from './helpers/returnFileCalls';
import versions from '../../pages/api/accounting/sars/returns/[form]/versions';

const gen = vi.hoisted(() => ({ relabel: false }));
vi.mock('@/modules/accounting/services/returns/filingFileContent', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/returns/filingFileContent')>();
  return {
    ...real,
    // A later generator: same version, different output (a field label reworded).
    buildCaptureSheet: (v: Parameters<typeof real.buildCaptureSheet>[0]) => {
      const sheet = real.buildCaptureSheet(v);
      if (!gen.relabel) return sheet;
      const csv = sheet.csv.replace('"Output tax on field 1"', '"Output tax on field 1 (reworded)"');
      return { ...sheet, csv, sha256: real.sha256Hex(csv) };
    },
  };
});

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
const APR = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const JUN = { periodStart: '2026-06-01', periodEnd: '2026-07-31' };
const sha = (b: unknown) => createHash('sha256').update(b as Buffer).digest('hex');
const text = (b: unknown) => (b as Buffer).toString('utf8');
let n = 0;
/** The mixed journal's zero-rated 500 sits in the box 1 base, so the 15% check fails; finalise records that (force). */
const MIXED = { force: true };

/** A posted sale in the period: standard-rated 1000 + 150 VAT, and 500 zero-rated on the same journal. */
async function sale(date: string, scale = 1): Promise<void> {
  const acct = async (subtype: string) => String(((await sql`SELECT id FROM gl_accounts
    WHERE company_id = ${a.fx.companyId}::UUID AND account_subtype = ${subtype} LIMIT 1`) as Row[])[0]!.id);
  const ar = await acct('receivable');
  const vat = await acct('vat_output');
  const sales = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
    normal_balance, is_active) VALUES (${a.fx.companyId}::UUID, ${`40${n += 1}0`}, ${`Sales ${n}`}, 'revenue', 'sales', 'credit', true)
    RETURNING id`) as Row[])[0]!.id);
  const je = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source,
    created_by) VALUES (${a.fx.companyId}::UUID, ${`EFV-${n}`}, ${date}::DATE, 'EFa VAT sale', 'posted', 'manual', ${a.admin.userId})
    RETURNING id`) as Row[])[0]!.id);
  for (const [acc, dr, cr, vt] of [[ar, 1650 * scale, 0, null], [sales, 0, 1000 * scale, 'standard'], [vat, 0, 150 * scale, 'standard'],
    [sales, 0, 500 * scale, 'zero_rated']] as Array<[string, number, number, string | null]>) {
    await sql`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, vat_type)
      VALUES (${je}::UUID, ${a.fx.companyId}::UUID, ${acc}::UUID, ${dr}, ${cr}, ${vt})`;
  }
}
const drawer = async (p: typeof APR, token = a.admin.token, form = 'vat201') =>
  callRoute(versions, a.fx.companyId, token, 'GET', { form, ...p });
const liveDrift = (r: { body: Row }) => ((r.body as { data: { versions: Array<{ status: string; drift: Row | null }> } })
  .data.versions.find((v) => v.status !== 'superseded')!.drift);
const field = (csv: string, f: string) => csv.split('\r\n').find((l) => l.split(',')[1] === `"${f}"`);

describeIfDb('EFa round 1: the VAT201 form, stored files, PRN facts, EMP201 versions', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, journals, VAT locks and return versions.');
    a = await seedReturnFixture('EFV', DATABASE_URL!);
    useFixture(a);
    await sql`UPDATE companies SET vat_number = '4123456789', paye_reference_number = '7123456789' WHERE id = ${a.fx.companyId}::UUID`;
    await sale('2026-04-15');
    await sale('2026-06-15');
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
  }, 120000);

  it('finalise records the SARS form; the drawer straight after shows no drift; a later journal is drift', async () => {
    const v = versionOf(await fin(APR, MIXED));
    const figures = (await row(String(v.id))).figures as { sarsForm: Array<{ field: string; amount: number | null }>; sarsFields: unknown[] };
    const form = Object.fromEntries(figures.sarsForm.map((f) => [f.field, f.amount]));
    expect(figures.sarsFields.length).toBeGreaterThan(0); // a period with VAT: the false drift needs boxes to reorder
    expect(form).toMatchObject({ 4: 150, 13: 150, 20: 150 });
    expect(form['1']).toBe(1150); // incl. VAT, the zero-rated 500 on the same journal given back
    expect(form['2']).toBe(500);
    const fresh = liveDrift(await drawer(APR));
    expect(fresh).toMatchObject({ drifted: false, changed: [], fields: [] });

    await sale('2026-05-02', 2); // inserted as the table owner: the app's VAT-lock guard is not under test here
    const moved = liveDrift(await drawer(APR));
    expect(moved).toMatchObject({ drifted: true });
    expect(moved!.changed).toContain('sarsFields');
  });

  it('the sheet is the recorded form field for field; then it is served as stored, whatever the generator says now', async () => {
    const id = String(versionOf(await fin(JUN, MIXED)).id);
    const first = await genFile(id, 'vat201', 'csv');
    expect(first.status).toBe(200);
    const csv = text(first.body);
    expect(field(csv, '4')).toBe('"Output tax: supplies","4","Output tax on field 1",150.00,');
    expect(field(csv, '13')).toBe('"Total A","13","Total output tax (4 + 4A + 9 + 11 + 12)",150.00,');
    expect(field(csv, '2')).toBe('"Output tax: supplies","2","Zero rate (excluding goods exported)",500.00,');
    expect(csv).not.toContain('14A/15A');
    const stamp = await row(id);
    expect(stamp).toMatchObject({ filing_file_sha256: sha(first.body), filing_file_kind: 'vat201_capture_csv@1', filing_file_content: csv });
    const json = text((await genFile(id, 'vat201', 'json')).body);

    gen.relabel = true; // the generator changes after the stamp
    try {
      const { buildCaptureSheet } = await import('@/modules/accounting/services/returns/filingFileContent');
      const same = { id, formType: 'VAT201', ...JUN, versionNo: 1, figures: stamp.figures } as never;
      expect(buildCaptureSheet(same).csv).toContain('(reworded)'); // the generator really says something else now
      const again = await genFile(id, 'vat201', 'csv');
      expect(again.status).toBe(200);
      expect(text(again.body)).toBe(csv);
      expect(sha(again.body)).toBe(stamp.filing_file_sha256);
      expect(text((await genFile(id, 'vat201', 'json')).body)).toBe(json);
    } finally {
      gen.relabel = false;
    }
    expect(await row(id)).toEqual(stamp);
  });

  it('a version finalised before the form was recorded has no sheet: 409, nothing written', async () => {
    // As finalise wrote a VAT201 before EFa (the boxes, no sarsForm), on its lock; inserted as the table owner.
    const lock = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
      posted_through, locked_by, actor_type) VALUES (${a.fx.companyId}::UUID, '2026-08-01', '2026-09-30', 0, 0, 0, now(),
      ${a.admin.userId}, 'human') RETURNING id`) as Row[])[0]!.id);
    const id = String(((await sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures,
      posted_through, finalised_by, vat_period_lock_id) VALUES (${a.fx.companyId}::UUID, 'VAT201', '2026-08-01', '2026-09-30', 1,
      ${JSON.stringify({ outputTax: 0, inputTax: 0, netVat: 0, sarsFields: [] })}::JSONB, now(), ${a.admin.userId}, ${lock}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    const before = await row(id);
    const r = await genFile(id, 'vat201', 'csv');
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/FILING_FILE_NO_FORM_LAYOUT/);
    expect(await row(id)).toEqual(before);
  });

  it('the PRN must carry the company\'s VAT number, and one PRN is one period\'s', async () => {
    const apr = String(((await sql`SELECT id FROM tax_return_versions WHERE company_id = ${a.fx.companyId}::UUID
      AND period_start = '2026-04-01' AND status = 'finalised'`) as Row[])[0]!.id);
    const jun = String(((await sql`SELECT id FROM tax_return_versions WHERE company_id = ${a.fx.companyId}::UUID
      AND period_start = '2026-06-01'`) as Row[])[0]!.id);
    const other = await fileV(jun, { reference: '4999999999V00000001', withoutFile: true });
    expect(other.status).toBe(400);
    expect(JSON.stringify(other.body)).toMatch(/FILING_REFERENCE_TAX_NUMBER/);
    expect((await row(jun)).status).toBe('finalised');
    expect((await fileV(jun, { reference: `${PRN('vat201', 7).slice(0, 10)}-v-${PRN('vat201', 7).slice(11)}`, withoutFile: true })).status).toBe(200);
    expect((await row(jun)).filed_reference).toBe(PRN('vat201', 7));
    // The submission's form_data holds what it held before EFa: the recorded form stays on the version.
    const formData = ((await sql`SELECT form_data FROM sars_submissions WHERE id = ${(await row(jun)).sars_submission_id}::UUID`) as Row[])[0]!.form_data as Row;
    expect(formData).toMatchObject({ outputTax: 150, returnVersionId: jun });
    expect(formData).not.toHaveProperty('sarsForm');
    // April's PRN may not be June's (judged before the drift April carries since the first test).
    const reused = await fileV(apr, { reference: PRN('vat201', 7) });
    expect(reused.status).toBe(409);
    expect(JSON.stringify(reused.body)).toMatch(/FILING_REFERENCE_REUSED/);
    expect((await row(apr)).status).toBe('finalised');
  });

  it('a VAT number on file that is not a valid SARS number: the filing goes ahead with the named warning, which the drawer shows', async () => {
    const FEB = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
    await sql`UPDATE companies SET vat_number = 'N/A' WHERE id = ${a.fx.companyId}::UUID`;
    try {
      const id = String(versionOf(await fin(FEB)).id);
      const filed = await fileV(id, { reference: '4555555555V00000009' });
      expect(filed.status).toBe(200);
      expect((filed.body as { data: { warnings: unknown[] } }).data.warnings).toEqual([{
        code: 'PRN_NOT_CROSS_CHECKED',
        message: 'The company VAT number on file is not a valid SARS number; the PRN was not cross-checked.',
      }]);
      const shown = ((await drawer(FEB)).body as { data: { versions: Array<{ id: string; filingWarnings: string[] }> } }).data.versions;
      expect(shown.find((v) => v.id === id)!.filingWarnings).toEqual([
        'The company VAT number on file is not a valid SARS number; the PRN was not cross-checked.']);
      // A filing that WAS cross-checked carries no warning (June, filed above against 4123456789).
      const jun = ((await drawer(JUN)).body as { data: { versions: Array<{ filingWarnings: string[] }> } }).data.versions;
      expect(jun.every((v) => v.filingWarnings.length === 0)).toBe(true);
    } finally {
      await sql`UPDATE companies SET vat_number = '4123456789' WHERE id = ${a.fx.companyId}::UUID`;
    }
  });

  it('EMP201 versions are payroll detail: a viewer gets 403 and no figures; VAT201 versions stay readable', async () => {
    const emp = await drawer(APR, a.viewer.token, 'emp201');
    expect(emp.status).toBe(403);
    expect(JSON.stringify(emp.body)).not.toMatch(/versions/);
    expect((await drawer(APR, a.manager.token, 'emp201')).status).toBe(200);
    expect((await drawer(APR, a.viewer.token, 'vat201')).status).toBe(200);
  });
});
