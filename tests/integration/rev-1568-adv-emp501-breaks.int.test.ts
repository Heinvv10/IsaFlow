/**
 * Adversarial repros for PR #1568 (EMP501 lifecycle). Each `it` asserts what a correct EMP501 must do; a red test is a
 * confirmed break. Every scenario gets its own company (seedReturnFixture), interim tax year 2026 (Mar-Aug 2025).
 */
import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, loginAsToken, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import returns from '../../pages/api/payroll/emp501/returns/index';
import emp501File from '../../pages/api/payroll/emp501/returns/filing-file';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import file from '../../pages/api/accounting/sars/returns/[form]/file';
import filingFile from '../../pages/api/accounting/sars/returns/[form]/filing-file';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';

type Row = Record<string, unknown>;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const INTERIM = { periodStart: '2025-03-01', periodEnd: '2025-08-31' };
const fixtures: ReturnFixture[] = [];

async function company(tag: string): Promise<ReturnFixture> {
  assertNotProductionDb('adversarial EMP501 repro');
  const rf = await seedReturnFixture(tag, DATABASE_URL!);
  fixtures.push(rf);
  await sql`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
    VALUES ('3601', 2026, 'income', 'Income', 'active') ON CONFLICT DO NOTHING`;
  refreshCache();
  await sql`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada',
    sars_contact_last_name = 'Lovelace', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street',
    physical_postal_code = '0001', physical_city = 'Pretoria' WHERE id = ${rf.fx.companyId}::UUID`;
  return rf;
}
async function employee(rf: ReturnFixture, last: string): Promise<string> {
  return String(((await sql`
    INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
    VALUES (${rf.fx.companyId}::UUID, ${last}, 'Test', ${last}, '2020-01-01', '1980-01-01', '8001015009087', '0123456789')
    RETURNING id`) as Row[])[0]!.id);
}
async function run(rf: ReturnFixture, month: number, lines: Array<[string, number, number]>,
  opts: { status?: string; approved?: boolean; kind?: 'regular' | 'off_cycle' } = {}): Promise<string> {
  const kind = opts.kind ?? 'regular';
  const id = String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, approved_at, run_kind, off_cycle_reason,
      period_start, period_end)
    VALUES (${rf.fx.companyId}::UUID, 2025, ${month}, ${opts.status ?? 'approved'}, ${lines.reduce((t, l) => t + l[1], 0)},
      ${lines.reduce((t, l) => t + l[2], 0)}, ${opts.approved === false ? null : '2025-04-01T10:00:00Z'}, ${kind},
      ${kind === 'off_cycle' ? 'bonus' : null}, make_date(2025, ${month}, 1), (make_date(2025, ${month}, 1) + INTERVAL '1 month - 1 day')::DATE)
    RETURNING id`) as Row[])[0]!.id);
  for (const [emp, gross, paye] of lines) {
    await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
      VALUES (${id}::UUID, ${emp}::UUID, ${gross}, ${gross}, ${paye}, 177.12, 177.12, ${gross / 100},
        ${JSON.stringify([{ sarsSourceCode: '3601', amount: gross }])}::JSONB)`;
  }
  return id;
}
/** File the month's EMP201 through the real lifecycle routes (finalise, download the file, mark filed). */
async function fileEmp201(rf: ReturnFixture, month: number): Promise<Row> {
  const mm = String(month).padStart(2, '0');
  const end = new Date(Date.UTC(2025, month, 0)).toISOString().slice(0, 10);
  const f = await callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { periodStart: `2025-${mm}-01`, periodEnd: end });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const v = (f.body as { data: { version: Row } }).data.version;
  expect((await callRoute(filingFile, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v.id, format: 'csv' })).status).toBe(200);
  const r = await callRoute(file, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' },
    { versionId: v.id, reference: `7123456789L000000${String(month).padStart(2, '0')}` });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return ((await sql`SELECT figures FROM tax_return_versions WHERE id = ${String(v.id)}::UUID`) as Row[])[0]!.figures as Row;
}
const finaliseEmp501 = (rf: ReturnFixture, token = rf.admin.token) =>
  callRoute(returns, rf.fx.companyId, token, 'POST', {}, { action: 'finalise', ...INTERIM });
const emp501Versions = async (rf: ReturnFixture) =>
  (await sql`SELECT * FROM tax_return_versions WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP501' ORDER BY version_no`) as Row[];
const legacyFiled = (rf: ReturnFixture, month: number) => sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
  VALUES (${rf.fx.companyId}::UUID, 'EMP201', make_date(2025, ${month}, 1), (make_date(2025, ${month}, 1) + INTERVAL '1 month - 1 day')::DATE,
    'submitted', ${`LEGACY-${month}`}, now())`;

describeIfDb('PR #1568 adversarial: EMP501 vs the EMP201s filed for its months', () => {
  afterAll(async () => {
    for (const rf of fixtures) {
      const c = rf.fx.companyId;
      await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c}::UUID`;
      // B3's standalone lump sum: its payment, directive and the posted journal (no fiscal period: the integrity check refuses it).
      await sql`DELETE FROM tax_directive_payments WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM tax_directives WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID AND entry_number LIKE 'JE-B3-%'`;
      await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
      await dropReturnFixture(rf);
    }
  }, 120000);

  it('B1: a March run changed and re-approved AFTER the March EMP201 was filed: EMP501 must not finalise totals the filed EMP201 does not carry', async () => {
    const rf = await company('B1');
    const alice = await employee(rf, 'Alice');
    const runId = await run(rf, 3, [[alice, 30_000, 4_000]]);
    const emp201 = await fileEmp201(rf, 3);
    // Reopen + re-approve with a corrected PAYE (the end state reopenPayrollRun + approvePayrollRun leave: new lines, new approval stamp).
    await sql`UPDATE payroll_run_lines SET paye = 9000 WHERE run_id = ${runId}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 9000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${runId}::UUID`;
    const r = await finaliseEmp501(rf);
    const v = (await emp501Versions(rf))[0];
    // eslint-disable-next-line no-console
    if (r.status === 200) {
      const dl = await callRoute(emp501File, rf.fx.companyId, rf.admin.token, 'POST', {}, { versionId: v!.id });
      const fl = await callRoute(returns, rf.fx.companyId, rf.admin.token, 'POST', {}, { action: 'file', versionId: v!.id, reference: 'EMP501REF123' });
      // eslint-disable-next-line no-console
      console.log('B1 download', dl.status, 'file', fl.status, JSON.stringify(await sql`SELECT form_type, status, form_data->'totals' AS t FROM sars_submissions WHERE company_id = ${rf.fx.companyId}::UUID ORDER BY form_type`));
    }
    // eslint-disable-next-line no-console
    console.log('B1', r.status, 'EMP201 filed PAYE', JSON.stringify(emp201).match(/"(totalPAYE|paye)":[0-9.]+/g), 'EMP501 totals', JSON.stringify((v?.figures as Row | undefined)?.totals));
    expect(r.status).toBe(409);
  });

  it('B2: an off-cycle run (refused by the EMP201 and irp5DataService run-kind guard) is certified by the EMP501', async () => {
    const rf = await company('B2');
    const alice = await employee(rf, 'Alice');
    await run(rf, 3, [[alice, 30_000, 4_000]]);
    await legacyFiled(rf, 3);
    await run(rf, 4, [[alice, 50_000, 20_000]], { kind: 'off_cycle' });
    await legacyFiled(rf, 4);
    const r = await finaliseEmp501(rf);
    const v = (await emp501Versions(rf))[0];
    // eslint-disable-next-line no-console
    console.log('B2', r.status, JSON.stringify(r.body).slice(0, 300), 'EMP501 totals', JSON.stringify((v?.figures as Row | undefined)?.totals));
    expect(r.status).toBe(409);
  });

  it('B1b: the March EMP201 was amended (v2 finalised with the new PAYE, NOT filed): readiness still counts March as filed', async () => {
    const rf = await company('B1b');
    const alice = await employee(rf, 'Alice');
    const runId = await run(rf, 3, [[alice, 30_000, 4_000]]);
    await fileEmp201(rf, 3);
    await sql`UPDATE payroll_run_lines SET paye = 9000 WHERE run_id = ${runId}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 9000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${runId}::UUID`;
    const v1 = ((await sql`SELECT id FROM tax_return_versions WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP201'`) as Row[])[0]!.id;
    const am = await callRoute(amend, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v1, reason: 'PAYE corrected' });
    expect(am.status, JSON.stringify(am.body)).toBe(200);
    const f2 = await callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { periodStart: '2025-03-01', periodEnd: '2025-03-31' });
    expect(f2.status, JSON.stringify(f2.body)).toBe(200);
    const g = await callRoute(returns, rf.fx.companyId, rf.admin.token, 'GET', INTERIM);
    const readiness = (g.body as { data: { readiness: Row } }).data.readiness;
    // eslint-disable-next-line no-console
    console.log('B1b readiness', JSON.stringify(readiness), 'emp201 rows', JSON.stringify(await sql`SELECT version_no, status FROM tax_return_versions WHERE company_id = ${rf.fx.companyId}::UUID AND form_type='EMP201' ORDER BY version_no`));
    expect(readiness.unfiledEmp201Months).toEqual(['2025-03']);
  });

  it('B3: PAYE on a lump sum paid outside payroll in a month with no pay run and no EMP201: finalise must refuse (no EMP201 declared that PAYE)', async () => {
    const rf = await company('B3');
    const c = rf.fx.companyId;
    const alice = await employee(rf, 'Alice');
    await run(rf, 3, [[alice, 30_000, 4_000]]);
    await legacyFiled(rf, 3);
    const directive = String(((await sql`INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, directive_number, amount, effective_date, issued_date, status)
      VALUES (${c}::UUID, ${alice}::UUID, 'Test Alice', 'severance', '123456789012', 100000, '2025-06-01', '2025-06-01', 'active') RETURNING id`) as Row[])[0]!.id);
    const je = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, description, entry_number)
      VALUES (${c}::UUID, '2025-06-10', ${rf.admin.userId}, 'posted', 'Severance', ${`JE-B3-${randomUUID().slice(0, 6)}`}) RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO tax_directive_payments (company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, journal_entry_id)
      VALUES (${c}::UUID, ${directive}::UUID, '2025-06-10', 100000, 18000, 82000, ${je}::UUID)`;
    const g = await callRoute(returns, c, rf.admin.token, 'GET', INTERIM);
    const r = await finaliseEmp501(rf);
    const v = (await emp501Versions(rf))[0];
    // eslint-disable-next-line no-console
    console.log('B3', 'readiness', JSON.stringify((g.body as { data?: { readiness?: unknown } }).data?.readiness), r.status, JSON.stringify(r.body).slice(0, 300), 'totals', JSON.stringify((v?.figures as Row | undefined)?.totals));
    expect(r.status).toBe(409);
  });

  it('B4: a never-approved (draft) run in June is not in the EMP501, so it must not block the finalise', async () => {
    const rf = await company('B4');
    const alice = await employee(rf, 'Alice');
    await run(rf, 3, [[alice, 30_000, 4_000]]);
    await legacyFiled(rf, 3);
    await run(rf, 6, [[alice, 30_000, 4_000]], { status: 'draft', approved: false });
    const r = await finaliseEmp501(rf);
    // eslint-disable-next-line no-console
    console.log('B4', r.status, JSON.stringify(r.body).slice(0, 300));
    expect(r.status).toBe(200);
  });

  it('C1 (control): a clean finalise shows no drift on the GET right after, and the file downloads twice to the same bytes', async () => {
    const rf = await company('C1');
    const a = await employee(rf, 'Alice');
    const b = String(((await sql`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
      VALUES (${rf.fx.companyId}::UUID, 'Alice2', 'Test', 'Alice', '2020-01-01', '1980-01-01', '8001015009087', '0123456789') RETURNING id`) as Row[])[0]!.id); // same name: seq order decided by a tie
    await run(rf, 3, [[a, 30_000, 4_000], [b, 31_000, 4_100]]);
    await legacyFiled(rf, 3);
    const r = await finaliseEmp501(rf);
    expect(r.status).toBe(200);
    const g = await callRoute(returns, rf.fx.companyId, rf.admin.token, 'GET', INTERIM);
    const versions = (g.body as { data: { versions: Array<{ drift: { drifted: boolean } }> } }).data.versions;
    expect(versions[0]!.drift.drifted).toBe(false);
    const id = String((await emp501Versions(rf))[0]!.id);
    const d1 = await callRoute(emp501File, rf.fx.companyId, rf.admin.token, 'POST', {}, { versionId: id });
    const d2 = await callRoute(emp501File, rf.fx.companyId, rf.admin.token, 'POST', {}, { versionId: id });
    expect(d1.status).toBe(200);
    expect(d2.body).toEqual(d1.body);
  });

  it('C2 (control): Login-as cannot finalise, download or amend; a manager cannot amend; an empty reason is refused', async () => {
    const rf = await company('C2');
    const a = await employee(rf, 'Alice');
    await run(rf, 3, [[a, 30_000, 4_000]]);
    await legacyFiled(rf, 3);
    const imp = await loginAsToken(rf);
    expect((await finaliseEmp501(rf, imp)).status).toBe(403);
    expect((await finaliseEmp501(rf)).status).toBe(200);
    const id = String((await emp501Versions(rf))[0]!.id);
    expect((await callRoute(emp501File, rf.fx.companyId, imp, 'POST', {}, { versionId: id })).status).toBe(403);
    expect((await callRoute(returns, rf.fx.companyId, imp, 'POST', {}, { action: 'amend', versionId: id, reason: 'x' })).status).toBe(403);
    expect((await callRoute(returns, rf.fx.companyId, rf.manager.token, 'POST', {}, { action: 'amend', versionId: id, reason: 'x' })).status).toBe(403);
    expect((await callRoute(returns, rf.fx.companyId, rf.admin.token, 'POST', {}, { action: 'amend', versionId: id, reason: '  ' })).status).toBe(400);
    expect((await emp501Versions(rf))[0]).toMatchObject({ status: 'finalised' });
  });
});
