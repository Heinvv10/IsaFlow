/**
 * R-035 N1b (C, migration 883), section 0 (adversarial review of PR #691,
 * F1; blind round 3, M1–M3, L6): an `owner` invitation an admin sent before
 * 883 — the route allowed it until this PR — would stay live, its token the
 * admin's; and `invited_by` proves nothing (it was writable too). 883 refuses
 * to apply while ANY unaccepted, unexpired owner invitation exists.
 *
 * Section 0's own text, read from the migration file, runs against private
 * TEMP copies of company_invitations and company_users (every reference to
 * either in it re-pointed there — a weakened check that joins members is read
 * against the copy too), inside a rolled-back transaction: the real table is
 * shared with the other integration files running in parallel, whose live
 * owner invitations would change the count — and the whole migration's DDL
 * would take locks under them.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const MIGRATION = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/883_company_member_role_guard.sql'), 'utf8');
const SECTION0 = MIGRATION.slice(MIGRATION.indexOf('-- ── 0. Precondition'), MIGRATION.indexOf('-- ── 1. The guards'));
const ON_COPY = SECTION0.replaceAll('public.company_invitations', 'pg_temp.company_invitations')
  .replaceAll('public.company_users', 'pg_temp.company_users');

type Setup = (c: PoolClient) => Promise<unknown>;

/** Section 0 against a copy holding the rows `setup` inserts: 'applied' or the error message. */
async function section0(setup: Setup): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('CREATE TEMP TABLE company_invitations (LIKE public.company_invitations INCLUDING DEFAULTS) ON COMMIT DROP');
    await c.query('CREATE TEMP TABLE company_users (LIKE public.company_users INCLUDING DEFAULTS) ON COMMIT DROP');
    await setup(c);
    await c.query(ON_COPY);
    return 'applied';
  } catch (error) {
    return (error as Error).message;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const invite = (role: string, expires = "now() + interval '7 days'", accepted = 'NULL') => (c: PoolClient) => c.query(
  `INSERT INTO pg_temp.company_invitations(id,company_id,email,role,invited_by,token,expires_at,accepted_at)
   VALUES('00000000-0000-4000-8000-000000000883','00000000-0000-4000-8000-000000000001','x@n1bc.test',$1,
          '00000000-0000-4000-8000-000000000002',md5(random()::text),${expires},${accepted})`, [role]);

/** The invitation's sender, `…0002`, made an owner of its company in the copy. */
const senderIsOwner: Setup = async (c) => {
  await invite('owner')(c);
  await c.query(`INSERT INTO pg_temp.company_users(company_id,user_id,role)
    VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','owner')`);
};

const REFUSED = /^migration 883: 1 pending owner invitation\(s\) exist and may have been sent or rewritten by a non-owner — cancel them before applying; an owner re-issues them afterwards: 00000000-0000-4000-8000-000000000883 \(company 00000000-0000-4000-8000-000000000001\)$/;

describe('migration 883 section 0', () => {
  it('is the block that reads company_invitations (the copy is really what it reads)', () => {
    expect(SECTION0).toContain('FROM public.company_invitations');
    expect(ON_COPY).not.toContain('public.company_invitations');
  });

  it('refuses even when the invitation names a current owner as its sender — invited_by proves nothing', async () => {
    expect(await section0(senderIsOwner)).toMatch(REFUSED);
  });

  it.each([
    ['owner', 'an owner invitation, whoever it names as sender'],
    ['Owner ', 'a role the accept routes would copy verbatim (L6)'],
    ['OWNER', 'upper case'],
  ])('refuses while a live %j invitation exists — %s — naming it by id and company', async (role) => {
    expect(await section0(invite(role))).toMatch(REFUSED);
  });

  it.each([
    ['it was accepted', invite('owner', "now() + interval '7 days'", 'now()')],
    ['it has expired', invite('owner', "now() - interval '1 day'")],
    ['it is for a lesser role', invite('manager')],
    ['there is none', async () => undefined],
  ])('applies when %s', async (_label, setup) => {
    expect(await section0(setup)).toBe('applied');
  });

  it('fails closed for a migration role that row-level security would filter (blind M1)', async () => {
    // The copy forced under RLS and owned by a role without BYPASSRLS — as
    // company_invitations is FORCE RLS: unexempt, the count saw nothing and passed.
    const role = `n1b_rls_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    expect(await section0(async (c) => {
      await invite('owner')(c);
      await c.query('ALTER TABLE pg_temp.company_invitations ENABLE ROW LEVEL SECURITY');
      await c.query('ALTER TABLE pg_temp.company_invitations FORCE ROW LEVEL SECURITY');
      await c.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
      await c.query(`GRANT ${role} TO CURRENT_USER`);
      await c.query(`ALTER TABLE pg_temp.company_invitations OWNER TO ${role}`);
      await c.query(`SET LOCAL ROLE ${role}`);
    })).toMatch(/row-level security/);
  });
});
