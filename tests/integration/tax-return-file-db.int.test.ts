/**
 * The table's own rules for filing and amending (migration 971), below the services: the column grants, the
 * status-transition guard, the same-company trigger on UPDATE, and the migration's one-open-draft dedupe and index.
 * Row checks run as app_user (SET LOCAL ROLE, withAuth's GUCs) in a transaction that is always rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { markSubmitted, saveDraftSubmission } from '../../src/modules/accounting/services/reports/sarsComplianceService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
let b: ReturnFixture;

const day = (m: number, last = false) => `2026-${String(m).padStart(2, '0')}-${last ? '28' : '01'}`;

async function submission(f: ReturnFixture, m: number, status = 'submitted', form = 'EMP201'): Promise<string> {
  return String(((await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference)
    VALUES (${f.fx.companyId}::UUID, ${form}, ${day(m)}::DATE, ${day(m, true)}::DATE, ${status}, 'R') RETURNING id`) as Row[])[0]!.id);
}

/** An EMP201 version of month m in the given state, inserted as the table owner (the fixture is not under test). */
async function version(f: ReturnFixture, m: number, state: 'finalised' | 'filed' | 'superseded'): Promise<string> {
  const sub = state === 'filed' ? await submission(f, m) : null;
  const rows = (await sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures,
    posted_through, finalised_by, status, sars_submission_id, filed_reference, filed_by, filed_at, amended_by, amend_reason, amended_at)
    VALUES (${f.fx.companyId}::UUID, 'EMP201', ${day(m)}::DATE, ${day(m, true)}::DATE, 1, '{}', now(), ${f.admin.userId}, ${state},
      ${sub}::UUID, ${sub ? 'REF' : null}, ${sub ? 'u' : null}, ${sub ? new Date().toISOString() : null}::TIMESTAMPTZ,
      ${state === 'superseded' ? 'u' : null}, ${state === 'superseded' ? 'why' : null},
      ${state === 'superseded' ? new Date().toISOString() : null}::TIMESTAMPTZ) RETURNING id`) as Row[];
  return String(rows[0]!.id);
}

async function asAppUser<T>(f: ReturnFixture, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await a.fx.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: f.admin.userId })]);
    await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [f.fx.companyId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** 'ok', or `<code> <message>` of one statement, in its own savepoint. */
async function failOf(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await c.query('SAVEPOINT f');
  try {
    await c.query(text, params);
    return 'ok';
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT f');
    const e = err as { code: string; message: string };
    return `${e.code} ${e.message}`;
  } finally {
    await c.query('RELEASE SAVEPOINT f').catch(() => undefined);
  }
}

const upd = (id: string, set: string) => `UPDATE tax_return_versions SET ${set} WHERE id = '${id}'`;
const U = () => a.admin.userId; // the session user asAppUser sets: filed_by and amended_by must be this
const FILE = (sub: string) => `status = 'filed', sars_submission_id = '${sub}', filed_reference = 'R1', filed_by = '${U()}', filed_at = now()`;
const AMEND = () => `status = 'superseded', amended_by = '${U()}', amend_reason = 'why', amended_at = now()`;
const INVISIBLE = [0x200b, 0x200c, 0xfeff, 0x00a0, 0x2003].map((c) => String.fromCharCode(c)).join(' ');

describeIfDb('tax_return_versions filing and amend rules (migration 971)', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, submissions and return versions.');
    a = await seedReturnFixture('RFD', DATABASE_URL!);
    b = await seedReturnFixture('RFD2', DATABASE_URL!);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
    if (b) await dropReturnFixture(b);
  }, 120000);

  it('app_user may UPDATE exactly the eight filing and amend columns; platform_admin may not', async () => {
    const allowed = ['status', 'sars_submission_id', 'filed_reference', 'filed_by', 'filed_at', 'amended_by', 'amend_reason', 'amended_at'];
    const cols = ((await sql`SELECT attname FROM pg_attribute WHERE attrelid = 'tax_return_versions'::regclass AND attnum > 0
      AND NOT attisdropped`) as Row[]).map((r) => String(r.attname));
    for (const col of cols) {
      const ok = ((await sql`SELECT has_column_privilege('app_user', 'tax_return_versions', ${col}, 'UPDATE') AS ok`) as Row[])[0]!.ok;
      expect(ok, col).toBe(allowed.includes(col));
      // app_service inherits app_user's grants (915); platform_admin (BYPASSRLS) must hold no UPDATE.
      expect(((await sql`SELECT has_column_privilege('platform_admin', 'tax_return_versions', ${col}, 'UPDATE') AS ok`) as Row[])[0]!.ok, `platform_admin ${col}`).toBe(false);
    }
    expect(((await sql`SELECT has_table_privilege('app_user', 'tax_return_versions', 'UPDATE') AS ok`) as Row[])[0]!.ok).toBe(false);
    expect(((await sql`SELECT has_table_privilege('app_user', 'tax_return_versions', 'DELETE') AS ok`) as Row[])[0]!.ok).toBe(false);
  });

  it('transitions: finalised to filed or superseded, filed to superseded; never out of superseded, never filed to finalised', async () => {
    const fin = await version(a, 1, 'finalised');
    const filed = await version(a, 2, 'filed');
    const sup = await version(a, 3, 'superseded');
    const sub = await submission(a, 1);
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(filed, `status = 'finalised'`))).toMatch(/^23514 .*may not move from filed to finalised/);
      expect(await failOf(c, upd(sup, `status = 'finalised'`))).toMatch(/^23514 .*superseded return is frozen/);
      expect(await failOf(c, upd(sup, `status = 'filed'`))).toMatch(/^23514 .*superseded return is frozen/);
      expect(await failOf(c, upd(sup, `amend_reason = 'rewritten'`))).toMatch(/^23514 .*superseded return is frozen/);
      expect(await failOf(c, upd(fin, FILE(sub)))).toBe('ok'); // the control: finalised to filed with every stamp
      expect(await failOf(c, upd(fin, AMEND()))).toBe('ok'); // filed to superseded, with the amend stamps
    });
  });

  it('the stamps: filing stamps are written together, once, and only by the move to filed; a supersede needs the amend stamps', async () => {
    const fin = await version(a, 4, 'finalised');
    const filed = await version(a, 5, 'filed');
    const sub = await submission(a, 4);
    const other = await submission(a, 5);
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(fin, `filed_reference = 'R'`))).toMatch(/^23514 .*written only by the move from finalised to filed/);
      expect(await failOf(c, upd(fin, `sars_submission_id = '${sub}'`))).toMatch(/^23514 .*written only by the move/);
      expect(await failOf(c, upd(fin, `status = 'filed', filed_reference = 'R', filed_by = 'u', filed_at = now()`)))
        .toMatch(/^23514 .*names its submission/); // no submission
      expect(await failOf(c, upd(fin, `status = 'filed', sars_submission_id = '${sub}', filed_reference = '  ', filed_by = 'u', filed_at = now()`)))
        .toMatch(/^23514 .*names its submission and carries a filing reference/);
      expect(await failOf(c, upd(fin, `status = 'superseded'`))).toMatch(/^23514 .*superseded only by an amend/);
      expect(await failOf(c, upd(filed, `filed_reference = 'CHANGED'`))).toMatch(/^23514 .*written once/);
      expect(await failOf(c, upd(filed, `filed_by = 'someone else'`))).toMatch(/^23514 .*written once/);
      expect(await failOf(c, upd(filed, `sars_submission_id = '${other}'`))).toMatch(/^23514 .*written once/);
      expect(await failOf(c, upd(filed, `${AMEND()}, filed_reference = 'CHANGED'`))).toMatch(/^23514 .*written once/);
      expect(await failOf(c, upd(filed, AMEND()))).toBe('ok'); // the control: the filing stamps stay as they were
    });
  });

  it('the same-company trigger fires on UPDATE of sars_submission_id: another company\'s, another period\'s or an unsubmitted submission is refused', async () => {
    const fin = await version(a, 6, 'finalised');
    const foreign = await submission(b, 6);
    const otherPeriod = await submission(a, 7);
    const draft = await submission(a, 6, 'draft');
    const wrongForm = await submission(a, 6, 'submitted', 'VAT201');
    const good = await submission(a, 6);
    const c = await a.fx.pool.connect(); // the owner, so RLS does not hide the foreign row: the TRIGGER must refuse it
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U() })]);
      for (const bad of [foreign, otherPeriod, draft, wrongForm]) {
        expect(await failOf(c, upd(fin, FILE(bad)))).toMatch(/^23514 .*is not this company's submitted submission for this form and period/);
      }
      expect(await failOf(c, upd(fin, FILE(good)))).toBe('ok');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('the same-company trigger also fires on UPDATE of amends_version_id and vat_period_lock_id (the immutability trigger lifted for the check)', async () => {
    const mine = await version(a, 8, 'finalised');
    const theirs = await version(b, 8, 'finalised');
    const theirLock = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax,
      net_vat, posted_through, locked_by) VALUES (${b.fx.companyId}::UUID, '2026-01-01', '2026-02-28', 0, 0, 0, now(), ${b.admin.userId})
      RETURNING id`) as Row[])[0]!.id);
    const c = await a.fx.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
      expect(await failOf(c, upd(mine, `amends_version_id = '${theirs}'`))).toMatch(/^23514 .*not a version of this company's same return/);
      expect(await failOf(c, upd(mine, `vat_period_lock_id = '${theirLock}'`))).toMatch(/^23514 .*not this company's active lock/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('who and when are the session\'s: a forged filed_by/amended_by or a stale or future time is refused, and so is a session with no user', async () => {
    const fin = await version(a, 9, 'finalised');
    const fin2 = await version(a, 10, 'finalised');
    const sub = await submission(a, 9);
    const mk = (by: string, at: string) =>
      `status = 'filed', sars_submission_id = '${sub}', filed_reference = 'R1', filed_by = '${by}', filed_at = ${at}`;
    const amend = (by: string, at: string) => `status = 'superseded', amended_by = '${by}', amend_reason = 'why', amended_at = ${at}`;
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(fin, mk('someone else', 'now()')))).toMatch(/^23514 .*session user/);
      expect(await failOf(c, upd(fin, mk(U(), `now() - interval '1 day'`)))).toMatch(/^23514 .*session user/);
      expect(await failOf(c, upd(fin, mk(U(), `now() + interval '1 day'`)))).toMatch(/^23514 .*session user/);
      expect(await failOf(c, upd(fin2, amend('forger', 'now()')))).toMatch(/^23514 .*session user/);
      expect(await failOf(c, upd(fin2, amend(U(), `now() - interval '1 hour'`)))).toMatch(/^23514 .*session user/);
      expect(await failOf(c, upd(fin, mk(U(), `now() - interval '2 minutes'`)))).toBe('ok'); // inside the five minutes
    });
    const o = await a.fx.pool.connect(); // the table's owner with no session user: direct SQL cannot file or supersede
    try {
      await o.query('BEGIN');
      expect(await failOf(o, upd(fin2, mk(U(), 'now()')))).toMatch(/^23514 .*session user/);
      expect(await failOf(o, upd(fin2, AMEND()))).toMatch(/^23514 .*session user/);
    } finally {
      await o.query('ROLLBACK').catch(() => undefined);
      o.release();
    }
  });

  it('a reference or reason must hold a visible character: whitespace and zero-width text is refused', async () => {
    const fin = await version(a, 11, 'finalised');
    const sub = await submission(a, 11);
    await asAppUser(a, async (c) => {
      expect(await failOf(c, `UPDATE tax_return_versions SET ${FILE(sub).replace("'R1'", '$1')} WHERE id = '${fin}'`, [INVISIBLE]))
        .toMatch(/^23514 .*filing reference must hold a visible character/);
      expect(await failOf(c, `UPDATE tax_return_versions SET ${AMEND().replace("'why'", '$1')} WHERE id = '${fin}'`, [INVISIBLE]))
        .toMatch(/^23514 .*amend reason must hold a visible character/);
      expect(await failOf(c, `UPDATE tax_return_versions SET ${AMEND().replace("'why'", '$1')} WHERE id = '${fin}'`, [`${INVISIBLE}x`])).toBe('ok');
    });
  });

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

  it('concurrent draft saves for one period leave ONE open draft (an advisory lock and a row lock, no index)', async () => {
    const save = (v: number) =>
      inTx(a.fx, () => saveDraftSubmission(a.fx.companyId, 'EMP201', '2026-09-01', '2026-09-30', { v }, a.admin.userId));
    const saved = await Promise.all([1, 2, 3, 4, 5, 6].map(save));
    expect(new Set(saved.map((r) => r.id)).size).toBe(1);
    const open = (await sql`SELECT COUNT(*)::INT AS n FROM sars_submissions WHERE company_id = ${a.fx.companyId}::UUID
      AND form_type = 'EMP201' AND period_start = '2026-09-01'::DATE AND status = 'draft'`) as Row[];
    expect(open[0]!.n).toBe(1);
  });
});
