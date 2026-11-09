/**
 * The table's own rules (migration 969), below the services: what app_user may not do, what the
 * CHECKs and the unique index refuse, and the same-company trigger. App_user checks run inside a
 * transaction with SET LOCAL ROLE app_user and withAuth's GUCs, so RLS and grants are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
let b: ReturnFixture;
const P = { start: '2026-02-01', end: '2026-03-31' };

const insertSql = (cols: string) => `INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end,
  version_no, figures, posted_through, finalised_by${cols}) VALUES`;

async function lockFor(f: ReturnFixture): Promise<string> {
  return String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax,
    net_vat, posted_through, locked_by) VALUES (${f.fx.companyId}::UUID, ${P.start}::DATE, ${P.end}::DATE, 0, 0, 0, now(), ${f.admin.userId})
    RETURNING id`) as Row[])[0]!.id);
}

/** Runs `fn` as app_user for `f`'s admin, in a transaction that is always rolled back. */
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

/** 'ok', or `<code> <message>` of one statement: the message names the constraint or trigger that refused it. */
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

/** The error code of one statement, run in its own savepoint so the transaction survives it. */
async function codeOf(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await c.query('SAVEPOINT s');
  try {
    await c.query(text, params);
    return 'ok';
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    return (err as { code: string }).code;
  } finally {
    await c.query('RELEASE SAVEPOINT s').catch(() => undefined);
  }
}

describeIfDb('tax_return_versions rules (migration 969)', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies and writes tax_return_versions rows.');
    a = await seedReturnFixture('RVD', DATABASE_URL!);
    b = await seedReturnFixture('RVD2', DATABASE_URL!);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
    if (b) await dropReturnFixture(b);
  }, 120000);

  it('app_user may insert its own company\'s version, and may not set status, update or delete', async () => {
    const lock = await lockFor(a);
    await asAppUser(a, async (c) => {
      const vals = `($1, 'VAT201', '${P.start}', '${P.end}', 1, '{}', now(), $2`;
      expect(await codeOf(c, `${insertSql(', vat_period_lock_id')} ${vals}, $3)`, [a.fx.companyId, a.admin.userId, lock])).toBe('ok');
      expect(await codeOf(c, `${insertSql(', vat_period_lock_id, status')} ${vals}, $3, 'filed')`,
        [a.fx.companyId, a.admin.userId, lock])).toBe('42501'); // status is not a column app_user may write
      expect(await codeOf(c, `UPDATE tax_return_versions SET status = 'superseded'`)).toBe('42501');
      expect(await codeOf(c, `DELETE FROM tax_return_versions`)).toBe('42501');
    });
  });

  it('RLS refuses an insert for another company, and a version of company B is invisible to company A', async () => {
    const lockB = await lockFor(b);
    await sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures, posted_through,
      vat_period_lock_id, finalised_by) VALUES (${b.fx.companyId}::UUID, 'VAT201', ${P.start}::DATE, ${P.end}::DATE, 1, '{}', now(),
      ${lockB}::UUID, ${b.admin.userId})`;
    await asAppUser(a, async (c) => {
      expect(await codeOf(c, `${insertSql('')} ($1, 'EMP201', '2026-02-01', '2026-02-28', 1, '{}', now(), $2)`,
        [b.fx.companyId, a.admin.userId])).toBe('42501');
      expect((await c.query('SELECT 1 FROM tax_return_versions WHERE company_id = $1', [b.fx.companyId])).rowCount).toBe(0);
    });
  });

  it('the trigger refuses another company\'s lock or amended version, and an amend of another period', async () => {
    const lockB = (await sql`SELECT id FROM vat_period_locks WHERE company_id = ${b.fx.companyId}::UUID`) as Row[];
    const verB = (await sql`SELECT id FROM tax_return_versions WHERE company_id = ${b.fx.companyId}::UUID`) as Row[];
    const c = await a.fx.pool.connect();
    await c.query('BEGIN');
    try {
      const w = (lock: unknown, amends: unknown, no: number, end = P.end) =>
        codeOf(c, `${insertSql(', vat_period_lock_id, amends_version_id')} ($1, 'VAT201', '${P.start}', '${end}', ${no}, '{}', now(), $2, $3, $4)`,
          [a.fx.companyId, a.admin.userId, lock, amends]);
      expect(await w(lockB[0]!.id, null, 1)).toBe('23514');
      const ownLock = (await sql`SELECT id FROM vat_period_locks WHERE company_id = ${a.fx.companyId}::UUID`) as Row[];
      expect(await w(ownLock[0]!.id, verB[0]!.id, 2)).toBe('23514');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('the CHECKs and the unique index: chain, lock, filed and one live version per period', async () => {
    const ownLock = String(((await sql`SELECT id FROM vat_period_locks WHERE company_id = ${a.fx.companyId}::UUID`) as Row[])[0]!.id);
    await sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures,
      posted_through, vat_period_lock_id, finalised_by) VALUES (${a.fx.companyId}::UUID, 'VAT201', ${P.start}::DATE, ${P.end}::DATE,
      1, '{}', now(), ${ownLock}::UUID, ${a.admin.userId})`;
    const c = await a.fx.pool.connect();
    await c.query('BEGIN');
    try {
      const ins = (extra: string, vals: string, form = 'VAT201', no = 1, start = P.start) =>
        failOf(c, `${insertSql(extra)} ($1, '${form}', '${start}', '${P.end}', ${no}, '{}', now(), $2${vals})`,
          [a.fx.companyId, a.admin.userId]);
      expect(await ins('', '', 'VAT201', 2)).toMatch(/^23514 .*tax_return_versions_chain_ck/); // version 2 with no amends_version_id
      expect(await ins('', '')).toMatch(/^23514 .*tax_return_versions_lock_ck/); // a VAT201 with no lock
      expect(await ins(', vat_period_lock_id', `, '${ownLock}'`, 'EMP201')).toMatch(/^23514 .*tax_return_versions_lock_ck/); // an EMP201 with a lock
      expect(await ins(', vat_period_lock_id', `, '${ownLock}'`)).toMatch(/^23505 .*uq_tax_return_versions_version/); // v1 again
      // filed_ck alone: its own active lock for ITS period, so no trigger fires first
      const fl = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
        posted_through, locked_by) VALUES (${a.fx.companyId}::UUID, '2026-08-01', '2026-09-30', 0, 0, 0, now(), ${a.admin.userId}) RETURNING id`) as Row[])[0]!.id);
      expect(await failOf(c, `${insertSql(', vat_period_lock_id, status')} ($1, 'VAT201', '2026-08-01', '2026-09-30', 1, '{}', now(), $2, $3, 'filed')`,
        [a.fx.companyId, a.admin.userId, fl])).toMatch(/^23514 .*tax_return_versions_filed_ck/); // filed with no filed_at / filed_by
      expect(await failOf(c, `${insertSql(', vat_period_lock_id, status, filed_at, filed_by')} ($1, 'VAT201', '2026-08-01', '2026-09-30', 1, '{}', now(), $2, $3, 'filed', now(), 'u')`,
        [a.fx.companyId, a.admin.userId, fl])).toBe('ok'); // the control: complete stamps pass
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('no role but the owner can write: platform_admin, app_service and app_user hold no UPDATE/DELETE, and the table refuses even a superuser', async () => {
    const priv = async (role: string, p: string) => ((await sql`SELECT has_table_privilege(${role}, 'tax_return_versions', ${p}) AS ok`) as Row[])[0]!.ok;
    for (const role of ['platform_admin', 'app_service', 'app_user']) {
      for (const p of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) expect(await priv(role, p), `${role} ${p}`).toBe(false);
    }
    expect(await priv('platform_admin', 'INSERT')).toBe(false);
    expect(await priv('platform_admin', 'SELECT')).toBe(true);
    expect(await priv('app_user', 'SELECT')).toBe(true);
    const c = await a.fx.pool.connect();
    await c.query('BEGIN');
    try {
      const updates: Record<string, string> = {
        id: 'gen_random_uuid()', company_id: `'${b.fx.companyId}'::UUID`, form_type: "'EMP201'", period_start: "'2026-01-01'::DATE",
        period_end: "'2026-04-30'::DATE", version_no: '7', figures: `'{"outputTax": 1}'::JSONB`,
        posted_through: "now() + interval '1 day'", vat_period_lock_id: 'NULL', amends_version_id: 'gen_random_uuid()',
        finalised_by: "'someone else'", finalised_at: "now() + interval '1 day'",
      };
      for (const [col, value] of Object.entries(updates)) {
        // Each recorded column alone, refused by the trigger (not by a CHECK that happens to fail too).
        expect(await failOf(c, `UPDATE tax_return_versions SET ${col} = ${value} WHERE company_id = '${a.fx.companyId}'`), col)
          .toMatch(/^23514 .*never changed/);
      }
      expect(await failOf(c, `DELETE FROM tax_return_versions WHERE company_id = $1`, [a.fx.companyId])).toMatch(/^23514 .*never deleted/);
      expect(await failOf(c, `TRUNCATE tax_return_versions`)).toMatch(/^23514 .*never truncated/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('the lock must be this company\'s ACTIVE lock for THIS period; an amend must name the same return; amend stamps are all-or-none on a superseded row', async () => {
    const live = (await sql`SELECT id, vat_period_lock_id FROM tax_return_versions WHERE company_id = ${a.fx.companyId}::UUID`) as Row[];
    const lock = String(live[0]!.vat_period_lock_id);
    const v1 = String(live[0]!.id);
    const other = { start: '2026-04-01', end: '2026-05-31' };
    const otherLock = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
      posted_through, locked_by) VALUES (${a.fx.companyId}::UUID, ${other.start}::DATE, ${other.end}::DATE, 0, 0, 0, now(), ${a.admin.userId})
      RETURNING id`) as Row[])[0]!.id);
    const unlocked = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
      posted_through, locked_by, unlocked_at, unlocked_by, unlock_reason) VALUES (${a.fx.companyId}::UUID, '2026-06-01', '2026-07-31', 0, 0, 0,
      now(), ${a.admin.userId}, now(), ${a.admin.userId}, 'direct') RETURNING id`) as Row[])[0]!.id);
    const c = await a.fx.pool.connect();
    await c.query('BEGIN');
    try {
      const ins = (start: string, end: string, no: number, lockId: string, amends: string | null, extra = '', vals = '') =>
        failOf(c, `${insertSql(', vat_period_lock_id, amends_version_id' + extra)} ($1, 'VAT201', $3, $4, ${no}, '{}', now(), $2, $5, $6${vals})`,
          [a.fx.companyId, a.admin.userId, start, end, lockId, amends]);
      expect(await ins(P.start, P.end, 2, otherLock, v1)).toMatch(/^23514 .*active lock for this period/); // another period's lock
      expect(await ins(other.start, other.end, 1, unlocked, null)).toMatch(/^23514 .*active lock for this period/); // an unlocked lock (and another period's)
      expect(await ins('2026-06-01', '2026-07-31', 1, unlocked, null)).toMatch(/^23514 .*active lock for this period/); // the right period, but unlocked
      expect(await ins(other.start, other.end, 2, otherLock, v1)).toMatch(/^23514 .*same return/); // amends a version of ANOTHER period, same company
      expect(await ins(P.start, P.end, 2, lock, v1)).toMatch(/^23505 .*uq_tax_return_versions_one_current/); // v1 is still live: one live version per period
      // amend_ck: stamps on a row that is not superseded, and a blank reason on a superseded one
      expect(await ins(other.start, other.end, 1, otherLock, null, ", amended_by, amend_reason, amended_at", ", 'u', 'why', now()")).toMatch(/^23514 .*tax_return_versions_amend_ck/);
      expect(await ins(other.start, other.end, 1, otherLock, null, ", status, amended_by, amend_reason, amended_at", ", 'superseded', 'u', '  ', now()")).toMatch(/^23514 .*tax_return_versions_amend_ck/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('an unlock cannot slip in between the lock check and the insert (the check holds the lock row FOR SHARE)', async () => {
    const lockId = String(((await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
      posted_through, locked_by) VALUES (${a.fx.companyId}::UUID, '2025-10-01', '2025-11-30', 0, 0, 0, now(), ${a.admin.userId}) RETURNING id`) as Row[])[0]!.id);
    const inserter = await a.fx.pool.connect();
    const unlocker = await a.fx.pool.connect();
    try {
      await inserter.query('BEGIN');
      await inserter.query(`${insertSql(', vat_period_lock_id')} ($1, 'VAT201', '2025-10-01', '2025-11-30', 1, '{}', now(), $2, $3)`,
        [a.fx.companyId, a.admin.userId, lockId]);
      await unlocker.query('BEGIN');
      await unlocker.query(`SET LOCAL lock_timeout = '300ms'`);
      const unlock = await failOf(unlocker, `UPDATE vat_period_locks SET unlocked_at = now(), unlocked_by = 'u', unlock_reason = 'race' WHERE id = $1`, [lockId]);
      expect(unlock).toMatch(/^55P03/); // the unlock waits for the inserting transaction
    } finally {
      await inserter.query('ROLLBACK');
      await unlocker.query('ROLLBACK');
      inserter.release();
      unlocker.release();
    }
  });
});

