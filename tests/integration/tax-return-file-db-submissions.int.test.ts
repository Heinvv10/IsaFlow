/**
 * Submissions, locks and drafts under migration 971: the freeze and lifecycle-only triggers on sars_submissions, the
 * lock trigger, the ISV intent event (own app_user transaction) and saveDraftSubmission's advisory lock. Same helpers as
 * tax-return-file-db.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import * as rules from './helpers/returnFileDbRules';
import { als } from '@/lib/als';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { applyPollResult, insertEfilingEventCommitted, withEventWriter } from '../../src/modules/accounting/services/reports/sarsEfilingRepo';
import { markSubmitted, saveDraftSubmission } from '../../src/modules/accounting/services/reports/sarsComplianceService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
let b: ReturnFixture;
const { day, submission, version, asAppUser, failOf, upd, U, FILE, AMEND, INVISIBLE, INVISIBLE_POINTS } = rules;

describeIfDb('sars_submissions, locks and drafts under migration 971', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, submissions and return versions.');
    a = await seedReturnFixture('RFS', DATABASE_URL!);
    b = await seedReturnFixture('RFS2', DATABASE_URL!);
    rules.setOwner(a);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
    if (b) await dropReturnFixture(b);
  }, 120000);

  it('a submission a version names keeps its status, reference and time, for every role; other columns and other rows may change', async () => {
    await version(a, 12, 'filed');
    const named = String(((await sql`SELECT sars_submission_id AS id FROM tax_return_versions WHERE company_id = ${a.fx.companyId}::UUID
      AND period_start = ${day(12)}::DATE`) as Row[])[0]!.id);
    const free = await submission(a, 12, 'draft', 'VAT201');
    const set = (id: string, what: string) => `UPDATE sars_submissions SET ${what} WHERE id = '${id}'`;
    await asAppUser(a, async (c) => {
      expect(await failOf(c, set(named, `submission_reference = 'CHANGED'`))).toMatch(/^23514 .*return lifecycle/);
      expect(await failOf(c, set(named, `status = 'draft'`))).toMatch(/^23514 .*return lifecycle/);
      expect(await failOf(c, set(named, `submitted_at = now()`))).toMatch(/^23514 .*return lifecycle/);
      expect(await failOf(c, set(named, `notes = 'a note'`))).toBe('ok');
      expect(await failOf(c, set(free, `status = 'submitted', submission_reference = 'R9', submitted_at = now()`))).toBe('ok');
    });
    const o = await a.fx.pool.connect();
    try {
      await o.query('BEGIN');
      expect(await failOf(o, set(named, `submission_reference = 'CHANGED'`))).toMatch(/^23514 .*return lifecycle/); // the owner too
    } finally {
      await o.query('ROLLBACK').catch(() => undefined);
      o.release();
    }
  });

  it('a draft becomes submitted only through the lifecycle once ANY version exists for its period (whatever its status)', async () => {
    await version(a, 7, 'superseded'); // nothing live: the amend gap
    const gap = await submission(a, 7, 'draft');
    const free = await submission(a, 7, 'draft', 'VAT201'); // another form: no version
    const sub = (id: string) => `UPDATE sars_submissions SET status = 'submitted', submission_reference = 'R', submitted_at = now() WHERE id = '${id}'`;
    await asAppUser(a, async (c) => {
      expect(await failOf(c, sub(gap))).toMatch(/^23514 .*return lifecycle/);
      expect(await failOf(c, sub(free))).toBe('ok');
      await c.query(`SELECT set_config('app.return_lifecycle', 'on', true)`);
      expect(await failOf(c, sub(gap))).toBe('ok'); // the lifecycle's own flag
    });
    const o = await a.fx.pool.connect();
    try {
      await o.query('BEGIN');
      expect(await failOf(o, sub(gap))).toMatch(/^23514 .*return lifecycle/); // the owner too
    } finally {
      await o.query('ROLLBACK').catch(() => undefined);
      o.release();
    }
  });

  it('ANY change to a non-draft row of a period that has a version needs the lifecycle flag (the old colour re-marking a submitted row)', async () => {
    const row = await submission(a, 7, 'submitted'); // unnamed, EMP201 month 7: that period has a (superseded) version
    const remark = `UPDATE sars_submissions SET submission_reference = 'HIJACK' WHERE id = '${row}'`;
    const restatus = `UPDATE sars_submissions SET status = 'accepted' WHERE id = '${row}'`;
    const retime = `UPDATE sars_submissions SET submitted_at = now() WHERE id = '${row}'`;
    await asAppUser(a, async (c) => {
      for (const q of [remark, restatus, retime]) expect(await failOf(c, q)).toMatch(/^23514 .*return lifecycle/);
      expect(await failOf(c, `UPDATE sars_submissions SET notes = 'n' WHERE id = '${row}'`)).toBe('ok'); // other columns stay free
      await c.query(`SELECT set_config('app.return_lifecycle', 'on', true)`);
      expect(await failOf(c, remark)).toBe('ok');
    });
    const other = await submission(a, 12, 'submitted', 'VAT201'); // a period with no VAT version: untouched
    await asAppUser(a, async (c) => {
      expect(await failOf(c, `UPDATE sars_submissions SET submission_reference = 'OK' WHERE id = '${other}'`)).toBe('ok');
    });
  });

  it('the ISV poll records SARS\'s verdict on a row it submitted even where a version exists; nothing else leaves a non-draft row, nothing leaves superseded', async () => {
    const mk = async (status: string, corr: string | null) => String(((await sql`INSERT INTO sars_submissions (company_id, form_type, period_start,
      period_end, status, efiling_correlation_id) VALUES (${a.fx.companyId}::UUID, 'EMP201', ${day(7)}::DATE, ${day(7, true)}::DATE, ${status}, ${corr})
      RETURNING id`) as Row[])[0]!.id);
    const polled = await mk('submitted', 'CORR-1'); // the period has a (superseded) version: this file's lifecycle test made it
    const noCorrelation = await mk('submitted', null);
    const superseded = await mk('superseded', 'CORR-2');
    const poll = (id: string, status: string, ref: string | null) =>
      inTx(a.fx, () => applyPollResult(a.fx.companyId, id, { submissionStatus: status, efilingStatus: status, sarsReference: ref }));
    await poll(polled, 'submitted', null); // still processing: no change to the watched columns
    await poll(polled, 'accepted', 'SARS-REF-1');
    expect(((await sql`SELECT status, submission_reference FROM sars_submissions WHERE id = ${polled}::UUID`) as Row[])[0])
      .toEqual({ status: 'accepted', submission_reference: 'SARS-REF-1' });
    await expect(poll(noCorrelation, 'accepted', 'X')).rejects.toThrow(/return lifecycle/);
    await expect(poll(superseded, 'submitted', null).then(() => poll(superseded, 'accepted', 'X'))).rejects.toThrow(/return lifecycle/);
    expect(String(((await sql`SELECT status FROM sars_submissions WHERE id = ${superseded}::UUID`) as Row[])[0]!.status)).toBe('superseded');
  });

  it('insertEfilingEventCommitted: an app_user transaction of its own (never a migration credential), the request\'s company as the GUC, committed past the request\'s ROLLBACK, a cross-company write refused', async () => {
    const sub = await submission(a, 12, 'draft', 'VAT201');
    const c = await a.fx.pool.connect();
    try {
      await c.query('BEGIN');
      await als.run({ client: c, userId: U(), companyId: a.fx.companyId, claims: { sub: U() } } as never, () => insertEfilingEventCommitted({
        companyId: a.fx.companyId, submissionId: sub, eventType: 'submit', efilingStatus: 'sending', message: 'about to send', createdBy: U(),
      }));
      await c.query('ROLLBACK'); // the request that was about to send fails
    } finally {
      c.release();
    }
    // scoped by the same RLS as any request: a request of company B cannot write company A's event
    const x = await a.fx.pool.connect();
    try {
      await x.query('BEGIN');
      await expect(als.run({ client: x, userId: b.admin.userId, companyId: b.fx.companyId, claims: { sub: b.admin.userId } } as never,
        () => insertEfilingEventCommitted({ companyId: a.fx.companyId, submissionId: sub, eventType: 'submit', createdBy: b.admin.userId }))).rejects.toThrow();
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      x.release();
    }
    const kept = (await sql`SELECT efiling_status FROM sars_efiling_events WHERE submission_id = ${sub}::UUID`) as Row[];
    expect(kept).toEqual([{ efiling_status: 'sending' }]);
    await sql`DELETE FROM sars_efiling_events WHERE submission_id = ${sub}::UUID`.catch(() => undefined);
  });

  it('a lock a live version names cannot be unlocked by any role; once the version is superseded it can', async () => {
    const P = { s: '2026-10-01', e: '2026-11-30' };
    const lock = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax,
      net_vat, posted_through, locked_by) VALUES (${a.fx.companyId}::UUID, ${P.s}::DATE, ${P.e}::DATE, 0, 0, 0, now(), ${U()})
      RETURNING id`) as Row[])[0]!.id);
    const ver = String(((await sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures,
      posted_through, vat_period_lock_id, finalised_by) VALUES (${a.fx.companyId}::UUID, 'VAT201', ${P.s}::DATE, ${P.e}::DATE, 1, '{}',
      now(), ${lock}::UUID, ${U()}) RETURNING id`) as Row[])[0]!.id);
    const unlock = `UPDATE vat_period_locks SET unlocked_at = now(), unlocked_by = '${U()}', unlock_reason = 'r' WHERE id = '${lock}'`;
    await asAppUser(a, async (c) => {
      expect(await failOf(c, unlock)).toMatch(/^23514 .*amend the return instead/);
      expect(await failOf(c, upd(ver, AMEND()))).toBe('ok');
      expect(await failOf(c, unlock)).toBe('ok');
    });
    const o = await a.fx.pool.connect();
    try {
      await o.query('BEGIN');
      expect(await failOf(o, unlock)).toMatch(/^23514 .*amend the return instead/); // the owner too
    } finally {
      await o.query('ROLLBACK').catch(() => undefined);
      o.release();
    }
  });

  it('withEventWriter holds ONE app_user connection for several committed events; a failed write does not poison the next', async () => {
    const sub = await submission(a, 12, 'draft', 'VAT201');
    const write = (kind: string, submissionId = sub) => ({
      companyId: a.fx.companyId, submissionId, eventType: 'submit' as const, efilingStatus: kind, createdBy: U(),
    });
    const c = await a.fx.pool.connect();
    try {
      await c.query('BEGIN');
      await als.run({ client: c, userId: U(), companyId: a.fx.companyId, claims: { sub: U() } } as never, () => withEventWriter(async (events) => {
        await events.write(write('sending'));
        await expect(events.write(write('bad', '00000000-0000-4000-8000-000000000066'))).rejects.toThrow(); // FK: no such submission
        await events.write(write('received'));
      }));
      await c.query('ROLLBACK'); // the request fails; the events were committed on the writer's own connection
    } finally {
      c.release();
    }
    const kept = (await sql`SELECT efiling_status FROM sars_efiling_events WHERE submission_id = ${sub}::UUID ORDER BY created_at`) as Row[];
    expect(kept).toEqual([{ efiling_status: 'sending' }, { efiling_status: 'received' }]);
  });

  it('saveDraftSubmission updates the open draft, and a period already filed gets a new draft (a correction)', async () => {
    const save = (data: Record<string, unknown>) =>
      inTx(a.fx, () => saveDraftSubmission(a.fx.companyId, 'VAT201', '2026-01-01', '2026-02-28', data, a.admin.userId));
    const first = await save({ v: 1 });
    const second = await save({ v: 2 });
    expect(second.id).toBe(first.id);
    expect(second.formData).toEqual({ v: 2 });
    const n = async () => Number(((await sql`SELECT COUNT(*)::INT AS n FROM sars_submissions WHERE company_id = ${a.fx.companyId}::UUID
      AND form_type = 'VAT201' AND period_start = '2026-01-01'::DATE`) as Row[])[0]!.n);
    expect(await n()).toBe(1);
    await inTx(a.fx, () => markSubmitted(a.fx.companyId, first.id, 'FILED-1'));
    const correction = await save({ v: 3 });
    expect(correction.id).not.toBe(first.id);
    expect(await n()).toBe(2);
    expect(String(((await sql`SELECT status FROM sars_submissions WHERE id = ${first.id}::UUID`) as Row[])[0]!.status)).toBe('submitted');
  });

  it('saveDraftSubmission refuses to run outside a request transaction (its advisory lock would serialise nothing)', async () => {
    await expect(saveDraftSubmission(a.fx.companyId, 'EMP201', '2026-08-01', '2026-08-31', {}, a.admin.userId))
      .rejects.toThrow(/inside a request transaction/);
  });

  it('a draft save that overlaps another\'s open transaction waits for it and updates its draft: ONE open draft (advisory lock + row lock, no index)', async () => {
    const save = (v: number) => saveDraftSubmission(a.fx.companyId, 'EMP201', '2026-09-01', '2026-09-30', { v }, a.admin.userId);
    const c1 = await a.fx.pool.connect();
    const c2 = await a.fx.pool.connect();
    try {
      await c1.query('BEGIN');
      const first = await runOn(a.fx, c1, () => save(1)); // inserted, not yet committed
      await c2.query('BEGIN');
      const second = runOn(a.fx, c2, () => save(2)); // must wait for c1, then see its draft
      await new Promise((r) => setTimeout(r, 400));
      await c1.query('COMMIT');
      const saved = await second;
      await c2.query('COMMIT');
      expect(saved.id).toBe(first.id);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined);
      await c2.query('ROLLBACK').catch(() => undefined);
      c1.release();
      c2.release();
    }
    const open = (await sql`SELECT COUNT(*)::INT AS n, MAX(form_data ->> 'v') AS v FROM sars_submissions
      WHERE company_id = ${a.fx.companyId}::UUID AND form_type = 'EMP201' AND period_start = '2026-09-01'::DATE AND status = 'draft'`) as Row[];
    expect(open[0]).toMatchObject({ n: 1, v: '2' });
  });
});
