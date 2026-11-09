/**
 * File and amend through the real routes (wave 5 L1b). A 4xx commits the request's writes under withAuth, so each
 * refusal is proved by counting rows AFTER the response: no submission, no override row, no version change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { seedInvoice } from './helpers/l1FifoFixture';
import {
  callRoute, count, dropReturnFixture, loginAsToken, releaseLockDirectly, seedReturnFixture, type ReturnFixture,
} from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import file from '../../pages/api/accounting/sars/returns/[form]/file';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';
import locks from '../../pages/api/accounting/vat-period-locks';
import legacySubmissions from '../../pages/api/accounting/sars/sars-submissions';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;

// The fixture company files bi-monthly, periods ending in odd months (Category A).
const CLEAN = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
const DIRTY = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const INVISIBLE = [0x200b, 0x200c, 0x200d, 0xfeff, 0x00a0].map((c) => String.fromCharCode(c)).join(' ');
const SWAPPED = { periodStart: '2026-08-01', periodEnd: '2026-09-30' };
let rf: ReturnFixture;
const c = () => rf.fx.companyId;
const fin = (p: typeof CLEAN, extra: Record<string, unknown> = {}, token = rf.admin.token) =>
  callRoute(finalise, c(), token, 'POST', { form: 'vat201' }, { ...p, ...extra });
const fileV = (id: string, body: Record<string, unknown> = {}, token = rf.admin.token, form = 'vat201') =>
  callRoute(file, c(), token, 'POST', { form }, { versionId: id, reference: 'REF-1', ...body });
const amendV = (id: string, body: Record<string, unknown> = { reason: 'Corrected a bill' }, token = rf.admin.token, form = 'vat201') =>
  callRoute(amend, c(), token, 'POST', { form }, { versionId: id, ...body });
const versionOf = (r: { body: Row }) => (r.body as { data: { version: Row } }).data.version;
const row = async (id: string) => ((await sql`SELECT * FROM tax_return_versions WHERE id = ${id}::UUID`) as Row[])[0]!;
const submissions = async () =>
  Number(((await sql`SELECT COUNT(*)::INT AS n FROM sars_submissions WHERE company_id = ${c()}::UUID`) as Row[])[0]!.n);
const audits = async (versionId: string) => (await sql`SELECT action, changes FROM audit_log WHERE company_id = ${c()}::UUID
  AND entity_type = 'tax_return_version' AND entity_id = ${versionId}::UUID ORDER BY created_at`) as Row[];
const legacy = (id: string, reference = 'LEGACY-1') =>
  callRoute(legacySubmissions, c(), rf.admin.token, 'POST', {}, { id, action: 'mark_submitted', reference });
const draftRow = async (formType: string, start: string, end: string, status = 'draft') => String(((await sql`INSERT INTO sars_submissions
  (company_id, form_type, period_start, period_end, status) VALUES (${c()}::UUID, ${formType}, ${start}::DATE, ${end}::DATE, ${status})
  RETURNING id`) as Row[])[0]!.id);
const overrides = () => count('vat_gate_overrides', c());
const lockActive = async (id: string) =>
  ((await sql`SELECT unlocked_at FROM vat_period_locks WHERE id = ${id}::UUID`) as Row[])[0]!.unlocked_at == null;

describeIfDb('file and amend a return, against a real ledger', () => {
  let v1: Row;
  let dirty: Row;
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, an invoice, locks, submissions and return versions.');
    rf = await seedReturnFixture('RFA', DATABASE_URL!);
    const inv = await seedInvoice(rf.fx, { number: 'INV-RFA', date: '2026-05-05', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150, total_amount = 1150
      WHERE id = ${inv}::UUID AND company_id = ${c()}::UUID`;
    v1 = versionOf(await fin(CLEAN));
    dirty = versionOf(await fin(DIRTY, { overrideReason: 'Declared on the manual return' }));
  }, 240000);
  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
  }, 120000);

  it('a file refused for blocking exceptions: 400, no submission, no override row, version unchanged', async () => {
    const ov = await overrides();
    const r = await fileV(String(dirty.id));
    expect(r.status).toBe(400);
    expect(await submissions()).toBe(0);
    expect(await overrides()).toBe(ov);
    expect((await row(String(dirty.id))).status).toBe('finalised');
  });

  it('an override by a manager: 403, nothing written', async () => {
    const ov = await overrides();
    expect((await fileV(String(dirty.id), { overrideReason: 'checked' }, rf.manager.token)).status).toBe(403);
    expect(await submissions()).toBe(0);
    expect(await overrides()).toBe(ov);
  });

  it('Login-as is refused: 403, nothing written', async () => {
    expect((await fileV(String(v1.id), {}, await loginAsToken(rf))).status).toBe(403);
    expect(await submissions()).toBe(0);
    expect((await row(String(v1.id))).status).toBe('finalised');
  });

  it('only an owner or admin files: a manager is 403 even with nothing to override, nothing written', async () => {
    expect((await fileV(String(v1.id), {}, rf.manager.token)).status).toBe(403);
    expect((await fileV(String(v1.id), {}, rf.viewer.token)).status).toBe(403);
    expect(await submissions()).toBe(0);
    expect((await row(String(v1.id))).status).toBe('finalised');
  });

  it('a blank or invisible reference or an unknown version or the wrong form: nothing written', async () => {
    expect((await fileV(String(v1.id), { reference: '   ' })).status).toBe(400);
    expect((await fileV(String(v1.id), { reference: INVISIBLE })).status).toBe(400);
    expect((await fileV('00000000-0000-4000-8000-000000000099')).status).toBe(404);
    expect((await fileV(String(v1.id), {}, rf.admin.token, 'emp201')).status).toBe(404);
    expect(await submissions()).toBe(0);
  });

  it('a clean period files: the version moves to filed with its submission, reference and who', async () => {
    const r = await fileV(String(v1.id), { reference: 'SARS-VAT-0001' });
    expect(r.status).toBe(200);
    const out = (r.body as { data: { version: Row; submission: Row } }).data;
    expect(out.version).toMatchObject({ status: 'filed', filedReference: 'SARS-VAT-0001', filedBy: rf.admin.userId });
    expect(out.version.sarsSubmissionId).toBe(out.submission.id);
    expect(out.submission).toMatchObject({ status: 'submitted', submissionReference: 'SARS-VAT-0001', formType: 'VAT201' });
    expect(await submissions()).toBe(1);
    // SEC-L2: the filing is audited in the same transaction, with its reference
    const trail = await audits(String(v1.id));
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: 'update' });
    expect(JSON.stringify(trail[0]!.changes)).toMatch(/SARS-VAT-0001/);
  });

  it('filing it again: 409, still one submission', async () => {
    expect((await fileV(String(v1.id), { reference: 'REF-2' })).status).toBe(409);
    expect(await submissions()).toBe(1);
  });

  it('an exceptions period files with an owner/admin override, recorded against the submission', async () => {
    const ov = await overrides();
    const r = await fileV(String(dirty.id), { overrideReason: 'Declared on the manual return' });
    expect(r.status).toBe(200);
    expect(await overrides()).toBe(ov + 1);
    const sub = String((r.body as { data: { submission: Row } }).data.submission.id);
    const o = (await sql`SELECT target_type, target_id FROM vat_gate_overrides WHERE company_id = ${c()}::UUID
      AND target_type = 'sars_submission'`) as Row[];
    expect(o).toHaveLength(1);
    expect(String(o[0]!.target_id)).toBe(sub);
  });

  it('a live version\'s lock cannot be unlocked directly: 409 "amend the return", the lock still locks', async () => {
    const lock = String(v1.vatPeriodLockId);
    const r = await callRoute(locks, c(), rf.admin.token, 'POST', {}, { action: 'unlock', lockId: lock, reason: 'just because' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/[Aa]mend the return/);
    expect(await lockActive(lock)).toBe(true);
  });

  it('an amend by a manager: 403; without a reason: 400; under Login-as: 403; unknown version: 404; nothing changes', async () => {
    const before = await row(String(v1.id));
    expect((await amendV(String(v1.id), { reason: 'x' }, rf.manager.token)).status).toBe(403);
    expect((await amendV(String(v1.id), { reason: '   ' })).status).toBe(400);
    expect((await amendV(String(v1.id), {})).status).toBe(400);
    expect((await amendV(String(v1.id), { reason: INVISIBLE })).status).toBe(400);
    expect((await amendV(String(v1.id), { reason: 'x' }, await loginAsToken(rf))).status).toBe(403);
    expect((await amendV('00000000-0000-4000-8000-000000000099')).status).toBe(404);
    expect((await amendV(String(v1.id), { reason: 'x' }, rf.admin.token, 'emp201')).status).toBe(404);
    expect(await row(String(v1.id))).toEqual(before);
    expect(await lockActive(String(v1.vatPeriodLockId))).toBe(true);
  });

  it('an amend supersedes the filed version with who and why, unlocks ONLY its own lock, and v2 files end to end', async () => {
    const r = await amendV(String(v1.id), { reason: 'Corrected a supplier bill' });
    expect(r.status).toBe(200);
    expect(versionOf(r)).toMatchObject({ status: 'superseded', amendedBy: rf.admin.userId, amendReason: 'Corrected a supplier bill' });
    expect(await lockActive(String(v1.vatPeriodLockId))).toBe(false);
    expect((await audits(String(v1.id))).map((a) => JSON.stringify(a.changes)).join('|')).toMatch(/Corrected a supplier bill/);
    expect(await lockActive(String(dirty.vatPeriodLockId))).toBe(true); // another period's lock is untouched
    expect((await amendV(String(v1.id))).status).toBe(409); // already amended
    expect((await fileV(String(v1.id))).status).toBe(409); // a superseded version cannot be filed

    const v2 = versionOf(await fin(CLEAN));
    expect(v2).toMatchObject({ versionNo: 2, amendsVersionId: v1.id, status: 'finalised' });
    expect(v2.vatPeriodLockId).not.toBe(v1.vatPeriodLockId);
    const filed = await fileV(String(v2.id), { reference: 'SARS-VAT-0002' });
    expect(filed.status).toBe(200);
    const sub2 = String((filed.body as { data: { submission: Row } }).data.submission.id);
    const sub1 = String((await row(String(v1.id))).sars_submission_id);
    expect(sub2).not.toBe(sub1); // a correction is a new submission; v1's stays
    expect(await submissions()).toBe(3);
    expect(String((await row(String(v2.id))).sars_submission_id)).toBe(sub2);
  });

  it('a version whose lock was released outside the lifecycle: filing is 409; an amend leaves a replacement lock alone', async () => {
    const v = versionOf(await fin(SWAPPED));
    const old = String(v.vatPeriodLockId);
    await releaseLockDirectly(rf.fx.pool, old, rf.admin.userId);
    const subs = await submissions();
    expect((await fileV(String(v.id))).status).toBe(409);
    expect(await submissions()).toBe(subs);
    const repl = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax,
      net_vat, posted_through, locked_by) VALUES (${c()}::UUID, ${SWAPPED.periodStart}::DATE, ${SWAPPED.periodEnd}::DATE, 0, 0, 0,
      now(), ${rf.admin.userId}) RETURNING id`) as Row[])[0]!.id);
    expect((await amendV(String(v.id))).status).toBe(200);
    expect(await lockActive(repl)).toBe(true); // unlocked by lock id, not by period
  });

  it('the legacy mark-submitted route cannot re-file, file a superseded draft, or file a period that has a live version', async () => {
    // (1) re-mark the submission of the filed v2 with another reference
    const v2sub = String(((await sql`SELECT sars_submission_id AS id FROM tax_return_versions WHERE company_id = ${c()}::UUID
      AND form_type = 'VAT201' AND period_start = ${CLEAN.periodStart}::DATE AND status = 'filed'`) as Row[])[0]!.id);
    const before = ((await sql`SELECT status, submission_reference, submitted_at FROM sars_submissions WHERE id = ${v2sub}::UUID`) as Row[])[0]!;
    expect((await legacy(v2sub, 'HIJACK')).status).toBe(409);
    expect(((await sql`SELECT status, submission_reference, submitted_at FROM sars_submissions WHERE id = ${v2sub}::UUID`) as Row[])[0]).toEqual(before);
    // (2) a superseded draft
    expect((await legacy(await draftRow('VAT201', '2025-01-01', '2025-02-28', 'superseded'))).status).toBe(409);
    // (3) a live-figures draft for a period that has a live version (no version names it)
    const live = await draftRow('VAT201', CLEAN.periodStart, CLEAN.periodEnd);
    expect((await legacy(live)).status).toBe(409);
    expect(String(((await sql`SELECT status FROM sars_submissions WHERE id = ${live}::UUID`) as Row[])[0]!.status)).toBe('draft');
    // control: a period no version covers still files the legacy way
    const free = await draftRow('EMP201', '2025-03-01', '2025-03-31');
    expect((await legacy(free, 'LEGACY-OK')).status).toBe(200);
    expect(String(((await sql`SELECT status FROM sars_submissions WHERE id = ${free}::UUID`) as Row[])[0]!.status)).toBe('submitted');
  });

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
});
