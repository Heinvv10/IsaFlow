/**
 * R-035 N1b (C, migration 886), section 0 (blind review of PR #693, LOW 1–3):
 * 886 refuses to apply while any company_users or company_invitations row holds
 * an owner-ish role (company_member_role_is_owner: lower-cased, every ASCII and
 * Unicode whitespace character removed) that is not exactly 'owner' — after it,
 * none exists, which is what makes the exact owner count and the exact portal
 * lock safe.
 *
 * As r035-n1b-members-precondition (883): section 0's own check, read from the
 * migration file, runs against private copies of both tables in a schema of
 * this file's own, each case inside a rolled-back transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const S = `n1b_pre886_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${S}`);
  await pool.query(`CREATE TABLE ${S}.company_invitations (LIKE public.company_invitations INCLUDING DEFAULTS)`);
  await pool.query(`CREATE TABLE ${S}.company_users (LIKE public.company_users INCLUDING DEFAULTS)`);
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  await pool.end();
});

const MIGRATION = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/886_company_member_role_guard_round5.sql'), 'utf8');
// The DO block only: the predicate it calls is 886's own, as applied (its body is pinned by the catalogue test),
// so a role that may not create in `public` (the RLS case) still runs it.
const SECTION0 = MIGRATION.slice(MIGRATION.indexOf('DO $$', MIGRATION.indexOf('-- ── 0. The owner predicate')), MIGRATION.indexOf('-- ── 1. The guards'));
const onCopy = () => SECTION0.replaceAll('public.company_invitations', `${S}.company_invitations`)
  .replaceAll('public.company_users', `${S}.company_users`);

type Setup = (c: PoolClient) => Promise<unknown>;
const COMPANY = '00000000-0000-4000-8000-000000000001';

/** Section 0 against the copies holding the rows `setup` inserts: 'applied' or the error message. */
async function section0(setup: Setup): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await setup(c);
    await c.query(onCopy());
    return 'applied';
  } catch (error) {
    return (error as Error).message;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const id = (kind: 8 | 9, i: number) => `00000000-0000-4000-${kind}000-${String(i).padStart(12, '0')}`;
const member = (role: string, i = 1) => (c: PoolClient) => c.query(
  `INSERT INTO ${S}.company_users(id,company_id,user_id,role) VALUES($1,$2,$3,$4)`, [id(8, i), COMPANY, `u${i}`, role]);
const invitation = (role: string, i = 1) => (c: PoolClient) => c.query(
  `INSERT INTO ${S}.company_invitations(id,company_id,email,role,invited_by,token,expires_at)
   VALUES($1,$2,$3,$4,'u0',md5(random()::text), now() - interval '1 day')`, [id(9, i), COMPANY, `x${i}@n1bc.test`, role]);
const all = (...setups: Setup[]): Setup => async (c) => { for (const s of setups) await s(c); };
const range = (n: number, make: (i: number) => Setup): Setup[] => Array.from({ length: n }, (_, k) => make(n - k)); // descending ids
const named = (message: string) => [...message.matchAll(/(company_\w+) ([0-9a-f-]{36}) \(company/g)].map((m) => `${m[1]} ${m[2]}`);
const refusal = (n: number) => new RegExp(`^migration 886: ${n} row\\(s\\) hold an owner role that is not exactly 'owner' — correct each role by hand before applying: `);

const OWNERISH = ['owner\t', ' Owner', 'OWNER', 'Owner ', ' owner', 'own er', 'owner ', '﻿owner', 'owner\n'];

describe('migration 886 section 0', () => {
  it('is the block that reads both tables (the copies are really what it reads)', () => {
    expect(SECTION0).toContain('FROM public.company_users');
    expect(SECTION0).toContain('FROM public.company_invitations');
    expect(onCopy()).not.toMatch(/public\.company_(users|invitations)\b/);
  });

  it.each([
    ['there are no rows', async () => undefined],
    ['every owner role is exactly owner', all(member('owner'), invitation('owner'))],
    ['the other roles are not owner-ish', all(member('owners', 1), member('co-owner', 2), member('admin', 3), invitation('manager'))],
  ])('applies when %s (0 rows)', async (_label, setup) => {
    expect(await section0(setup)).toBe('applied');
  });

  it.each(OWNERISH)('refuses a membership with role %j, naming it by id and company', async (role) => {
    const message = await section0(member(role));
    expect(message).toMatch(refusal(1));
    expect(named(message)).toEqual([`company_users ${id(8, 1)}`]);
    expect(message).not.toMatch(/more\)$/);
  });

  it.each(OWNERISH)('refuses an invitation (expired or not) with role %j', async (role) => {
    const message = await section0(invitation(role));
    expect(message).toMatch(refusal(1));
    expect(named(message)).toEqual([`company_invitations ${id(9, 1)}`]);
  });

  it('names all ten, with no tail, when there are exactly ten', async () => {
    const message = await section0(all(...range(10, (i) => member(OWNERISH[i % OWNERISH.length]!, i))));
    expect(message).toMatch(refusal(10));
    expect(message).not.toMatch(/more\)$/);
    expect(named(message)).toEqual(Array.from({ length: 10 }, (_, k) => `company_users ${id(8, k + 1)}`));
  });

  it('names the first ten by table and id, then how many more, at eleven', async () => {
    const message = await section0(all(...range(5, (i) => member('OWNER', i)), ...range(6, (i) => invitation(' Owner', i))));
    expect(message).toMatch(refusal(11));
    expect(message).toMatch(/ \(\+1 more\)$/);
    expect(named(message)).toEqual([
      ...Array.from({ length: 6 }, (_, k) => `company_invitations ${id(9, k + 1)}`),
      ...Array.from({ length: 4 }, (_, k) => `company_users ${id(8, k + 1)}`),
    ]);
  });

  it('fails closed for a migration role that row-level security would filter', async () => {
    const role = `n1b_rls_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    expect(await section0(async (c) => {
      await member('Owner ')(c);
      await c.query(`ALTER TABLE ${S}.company_users ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE ${S}.company_users FORCE ROW LEVEL SECURITY`);
      await c.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
      await c.query(`GRANT ${role} TO CURRENT_USER`);
      await c.query(`GRANT USAGE, CREATE ON SCHEMA ${S} TO ${role}`);
      await c.query(`ALTER TABLE ${S}.company_users OWNER TO ${role}`);
      await c.query(`ALTER TABLE ${S}.company_invitations OWNER TO ${role}`);
      await c.query(`SET LOCAL ROLE ${role}`);
    })).toMatch(/row-level security/);
  });

  it('counts a row another session writes while the migration runs: it waits for it, then refuses', async () => {
    const writer = await pool.connect();
    const migrator = await pool.connect();
    try {
      await writer.query('BEGIN');
      await member('Owner ')(writer);
      await migrator.query('BEGIN');
      const pid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const run = migrator.query(onCopy()).then(() => 'applied', (e: Error) => e.message);
      for (let i = 0; ; i++) {
        if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])).rows.length) break;
        if (i > 200) throw new Error('section 0 never waited for the uncommitted writer');
        await new Promise((r) => setTimeout(r, 50));
      }
      await writer.query('COMMIT');
      expect(await run).toMatch(refusal(1));
    } finally {
      await migrator.query('ROLLBACK').catch(() => undefined);
      await writer.query('ROLLBACK').catch(() => undefined);
      await pool.query(`DELETE FROM ${S}.company_users`);
      migrator.release();
      writer.release();
    }
  });
});
