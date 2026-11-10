/**
 * The table's own rules for filing and amending (migration 971), below the services: the column grants, the
 * status-transition guard, the stamps (session user, clock, visible text, amend stamps) and the same-company trigger on
 * UPDATE. Row checks run as app_user (SET LOCAL ROLE, withAuth's GUCs) in a transaction that is always rolled back.
 * The submission, lock and draft rules are in tax-return-file-db-submissions.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import * as rules from './helpers/returnFileDbRules';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
let b: ReturnFixture;
const { day, submission, version, asAppUser, failOf, upd, U, FILE, AMEND, INVISIBLE, INVISIBLE_POINTS } = rules;

describeIfDb('tax_return_versions filing and amend rules (migration 971)', () => {
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
      for (const cp of INVISIBLE_POINTS) {
        const text = String.fromCodePoint(cp);
        const where = `U+${cp.toString(16).toUpperCase()}`;
        expect(await failOf(c, `UPDATE tax_return_versions SET ${FILE(sub).replace("'R1'", '$1')} WHERE id = '${fin}'`, [text]), where)
          .toMatch(/^23514 .*visible character/);
        expect(await failOf(c, `UPDATE tax_return_versions SET ${AMEND().replace("'why'", '$1')} WHERE id = '${fin}'`, [text]), where)
          .toMatch(/^23514 .*visible character/);
      }
      expect(await failOf(c, `UPDATE tax_return_versions SET ${AMEND().replace("'why'", '$1')} WHERE id = '${fin}'`, [`${INVISIBLE}x`])).toBe('ok');
    });
  });

  it('the amend stamps change only with the move to superseded', async () => {
    const fin = await version(b, 3, 'finalised');
    await asAppUser(b, async (c) => {
      expect(await failOf(c, upd(fin, `amended_by = 'x'`))).toMatch(/^23514 .*amend stamps change only with the move to superseded/);
      expect(await failOf(c, upd(fin, `amend_reason = 'x'`))).toMatch(/^23514 .*amend stamps change only/);
      expect(await failOf(c, upd(fin, `amended_at = now()`))).toMatch(/^23514 .*amend stamps change only/);
    });
  });
});
