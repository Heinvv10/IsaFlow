/**
 * File and amend through the real routes (wave 5 L1b), the guards that need no VAT chain: EMP201 drift, the filed
 * submission's figures and `pageDraft`, a legacy-filed period, NUL and invisible text, the payroll approval lock, the EMP201
 * lifecycle and the 429 on both routes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedInvoice } from './helpers/l1FifoFixture';
import { submitVAT201ToSars } from '../../src/modules/accounting/services/reports/sarsEfilingSubmissionService';
import {
  callRoute, count, dropReturnFixture, loginAsToken, releaseLockDirectly, seedReturnFixture, type ReturnFixture,
} from './helpers/returnVersionsFixture';
import {
  CLEAN, DIRTY, INVISIBLE, SWAPPED, amendV, audits, c, draftRow, fileV, fin, legacy, lockActive, overrides, row, submissions, useFixture, versionOf,
} from './helpers/returnFileCalls';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import file from '../../pages/api/accounting/sars/returns/[form]/file';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';
import locks from '../../pages/api/accounting/vat-period-locks';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let rf: ReturnFixture;
const ANY_VERSION = '00000000-0000-4000-8000-000000000091'; // refused (400) before any lookup

describeIfDb('file and amend a return: guards on their own company', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, pay runs, submissions and return versions.');
    rf = await seedReturnFixture('RFG', DATABASE_URL!);
    useFixture(rf);
  }, 240000);
  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
  }, 120000);

  it('an EMP201 version that has drifted from payroll is not filed: 409 naming the drift, nothing written', async () => {
    const period = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
    await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, total_uif,
      total_sdl, total_eti, employee_count, approved_at) VALUES (${c()}::UUID, 2026, 9, 'approved', 50000, 9000, 500, 500, 0, 1,
      '2026-09-30T10:00:00Z')`;
    const e = versionOf(await callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' }, period));
    await sql`UPDATE payroll_run_headers SET total_paye = 9100 WHERE company_id = ${c()}::UUID AND period_month = 9`;
    const subs = await submissions();
    const r = await fileV(String(e.id), { reference: 'EMP-DRIFT' }, rf.admin.token, 'emp201');
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/totalPAYE/);
    expect(await submissions()).toBe(subs);
    expect((await row(String(e.id))).status).toBe('finalised');
  });

  it('the filed submission carries the version\'s figures, whatever the page saved; an in-flight eFiling draft is not overwritten (409)', async () => {
    const per = (m: number) => ({ periodStart: `2026-${String(m).padStart(2, '0')}-01`, periodEnd: `2026-${String(m).padStart(2, '0')}-${new Date(Date.UTC(2026, m, 0)).getUTCDate()}` });
    const fin = async (m: number) => versionOf(await callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' }, per(m)));
    // a draft the page saved with other figures
    const e = await fin(6);
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, form_data)
      VALUES (${c()}::UUID, 'EMP201', ${per(6).periodStart}::DATE, ${per(6).periodEnd}::DATE, 'draft', ${JSON.stringify({ totalPAYE: 99999, note: 'page' })}::jsonb)`;
    const r = await fileV(String(e.id), { reference: 'EMP-FIG' }, rf.admin.token, 'emp201');
    expect(r.status).toBe(200);
    const fd = (r.body as { data: { submission: { formData: Row } } }).data.submission.formData;
    expect(fd).toMatchObject({ ...(e.figures as Row), returnVersionId: e.id, versionNo: 1, pageDraft: { totalPAYE: 99999, note: 'page' } });
    expect(fd.totalPAYE).toBe((e.figures as Row).totalPAYE);
    // an in-flight ISV submit on the open draft: refused, nothing changes
    const e2 = await fin(5);
    const inflight = String(((await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, form_data,
      efiling_correlation_id) VALUES (${c()}::UUID, 'EMP201', ${per(5).periodStart}::DATE, ${per(5).periodEnd}::DATE, 'draft', '{"k":1}'::jsonb,
      'corr-1') RETURNING id`) as Row[])[0]!.id);
    expect((await fileV(String(e2.id), { reference: 'EMP-ISV' }, rf.admin.token, 'emp201')).status).toBe(409);
    expect((await row(String(e2.id))).status).toBe('finalised');
    expect(((await sql`SELECT status, form_data FROM sars_submissions WHERE id = ${inflight}::UUID`) as Row[])[0]).toEqual({ status: 'draft', form_data: { k: 1 } });
  });

  it('a period already filed the legacy way: 409 LEGACY_SUBMISSION_EXISTS until the filing names it and says why; then it is superseded', async () => {
    const per = { periodStart: '2026-03-01', periodEnd: '2026-03-31' };
    const e = versionOf(await callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' }, per));
    const legacyRow = await draftRow('EMP201', per.periodStart, per.periodEnd, 'submitted'); // filed the legacy way, before versions
    const subs = async () => ((await sql`SELECT id, status FROM sars_submissions WHERE company_id = ${c()}::UUID AND form_type = 'EMP201'
      AND period_start = ${per.periodStart}::DATE ORDER BY status`) as Row[]);
    const before = await subs();
    const r = await fileV(String(e.id), { reference: 'EMP-LEG' }, rf.admin.token, 'emp201');
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/LEGACY_SUBMISSION_EXISTS/);
    expect(JSON.stringify(r.body)).toContain(legacyRow);
    // the wrong id, and the right id with no reason
    const wrong = await fileV(String(e.id), { reference: 'EMP-LEG', correctsLegacySubmissionId: '00000000-0000-4000-8000-000000000077', reason: 'because' }, rf.admin.token, 'emp201');
    expect(wrong.status).toBe(409);
    expect((await fileV(String(e.id), { reference: 'EMP-LEG', correctsLegacySubmissionId: legacyRow }, rf.admin.token, 'emp201')).status).toBe(400);
    expect((await fileV(String(e.id), { reference: 'EMP-LEG', correctsLegacySubmissionId: legacyRow, reason: INVISIBLE }, rf.admin.token, 'emp201')).status).toBe(400);
    expect(await subs()).toEqual(before);
    expect((await row(String(e.id))).status).toBe('finalised');
    // acknowledged: the legacy row is superseded, ONE live submitted row remains, and the audit names both
    const ok = await fileV(String(e.id), { reference: 'EMP-LEG', correctsLegacySubmissionId: legacyRow, reason: 'Re-filed through the lifecycle' }, rf.admin.token, 'emp201');
    expect(ok.status).toBe(200);
    const after = (await sql`SELECT id, status, notes FROM sars_submissions WHERE company_id = ${c()}::UUID AND form_type = 'EMP201'
      AND period_start = ${per.periodStart}::DATE`) as Row[];
    expect(after.filter((x) => x.status === 'submitted')).toHaveLength(1);
    expect(after.find((x) => x.id === legacyRow)).toMatchObject({ status: 'superseded' });
    expect(String(after.find((x) => x.id === legacyRow)!.notes)).toMatch(/Re-filed through the lifecycle/);
    expect(JSON.stringify((await audits(String(e.id)))[0]!.changes)).toContain(legacyRow);
  });

  it('a NUL character in a reference or a reason is a 400, never a 500', async () => {
    const nul = String.fromCharCode(0);
    const id = ANY_VERSION;
    expect((await fileV(id, { reference: `REF${nul}1` })).status).toBe(400);
    expect((await amendV(id, { reason: `why${nul}` })).status).toBe(400);
  });

  it('every invisible character is a 400 for a reference and for a reason, never a 500', async () => {
    const points = [0xad, 0x85, 0xa0, 0x34f, 0x115f, 0x1160, 0x1680, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x2000, 0x200b, 0x200f,
      0x2028, 0x202f, 0x205f, 0x2060, 0x206f, 0x2800, 0x3000, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xe0000, 0xe0020, 0xe0fff,
  0x61c, 0xfff9, 0xfffa, 0xfffb, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a];
    const id = ANY_VERSION;
    for (const cp of points) {
      const text = String.fromCodePoint(cp);
      expect((await fileV(id, { reference: text })).status, `file U+${cp.toString(16)}`).toBe(400);
      expect((await amendV(id, { reason: ` ${text} ` })).status, `amend U+${cp.toString(16)}`).toBe(400);
    }
  });

  it('an EMP201 filing waits for an approval in flight, so the drift check and the commit see one payroll state', async () => {
    const period = { periodStart: '2026-07-01', periodEnd: '2026-07-31' };
    await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, total_uif,
      total_sdl, total_eti, employee_count, approved_at) VALUES (${c()}::UUID, 2026, 7, 'approved', 50000, 9000, 500, 500, 0, 1,
      '2026-07-31T10:00:00Z')`;
    const e = versionOf(await callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' }, period));
    const approver = await rf.fx.pool.connect();
    try {
      // an approval/reopen in flight: it holds the company's payroll approval lock and has changed the run, uncommitted
      await approver.query('BEGIN');
      await approver.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_approval:${c()}`]);
      await approver.query(`UPDATE payroll_run_headers SET total_paye = 9100 WHERE company_id = $1 AND period_month = 7`, [c()]);
      const filing = fileV(String(e.id), { reference: 'EMP-LOCK' }, rf.admin.token, 'emp201');
      await new Promise((r) => setTimeout(r, 500));
      await approver.query('COMMIT');
      const r = await filing;
      expect(r.status).toBe(409); // read after the approval committed: the drift is seen
      expect(JSON.stringify(r.body)).toMatch(/totalPAYE/);
      expect((await row(String(e.id))).status).toBe('finalised');
    } finally {
      await approver.query('ROLLBACK').catch(() => undefined);
      approver.release();
    }
  });

  it('EMP201: a nil month files with no VAT gate, amends (no lock involved) and v2 files', async () => {
    const r = await callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' },
      { periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    expect(r.status).toBe(200);
    const e1 = versionOf(r);
    const ov = await overrides();
    const f1 = await fileV(String(e1.id), { reference: 'EMP-0001' }, rf.admin.token, 'emp201');
    expect(f1.status).toBe(200);
    expect(await overrides()).toBe(ov); // no VAT gate for an EMP201
    // No VAT lock is involved, so the amend's own Login-as guard is the only one in the way.
    const before = await row(String(e1.id));
    expect((await amendV(String(e1.id), { reason: 'Late payroll correction' }, await loginAsToken(rf), 'emp201')).status).toBe(403);
    expect(await row(String(e1.id))).toEqual(before);
    expect((await amendV(String(e1.id), { reason: 'Late payroll correction' }, rf.admin.token, 'emp201')).status).toBe(200);
    const e2 = versionOf(await callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' },
      { periodStart: '2026-08-01', periodEnd: '2026-08-31' }));
    expect(e2).toMatchObject({ versionNo: 2, amendsVersionId: e1.id });
    expect((await fileV(String(e2.id), { reference: 'EMP-0002' }, rf.admin.token, 'emp201')).status).toBe(200);
  });

  it('both routes answer 429 once a user is over the rate limit (checked before any lookup or write)', async () => {
    const id = '00000000-0000-4000-8000-000000000098';
    const call = (route: typeof file | typeof amend, body: Record<string, unknown>) =>
      callRoute(route, c(), rf.manager.token, 'POST', { form: 'vat201' }, { versionId: id, ...body });
    // the manager is write-capable and refused 403 by the service, so each call spends one unit of its own budget
    for (const [route, body] of [[file, { reference: 'R' }], [amend, { reason: 'why' }]] as const) {
      let last = 0;
      for (let i = 0; i < 125 && last !== 429; i += 1) last = (await call(route, body)).status;
      expect(last).toBe(429);
    }
  });
});
