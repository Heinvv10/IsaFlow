/**
 * R-035 N1b (C, migration 883), section 0 (adversarial review of PR #691,
 * F1): an `owner` invitation an admin sent before 883 — the route allowed it
 * until this PR — would stay live, its token the admin's. 883 refuses to
 * apply while any unaccepted, unexpired owner invitation exists whose sender
 * is not an owner of the company. Run against poisoned states inside one
 * rolled-back transaction, as the deploy role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupMembers, company, people, tokenHash, type People } from './r035-n1b-members.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
let p: People;
beforeAll(async () => { p = await people(pool, users); });
afterAll(() => cleanupMembers(pool, companies, users));
const MIGRATION = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/883_company_member_role_guard.sql'), 'utf8');

async function applyAfter(poison: (c: PoolClient) => Promise<void>): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await poison(c);
    await c.query(MIGRATION);
    return 'applied';
  } catch (error) {
    return (error as Error).message;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const legacy = (c: PoolClient, co: string, by: string, extra = '') => c.query(
  `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at${extra ? ',accepted_at' : ''})
   VALUES($1,'legacy@n1bc.test','owner',$2,$3, now() + interval '7 days'${extra})`, [co, by, tokenHash(crypto.randomUUID())]);

describe('migration 883 section 0', () => {
  it('refuses while a live owner invitation sent by an admin exists', async () => {
    const co = await company(pool, p, companies);
    expect(await applyAfter((c) => legacy(c, co, p.a).then(() => undefined)))
      .toBe('migration 883: 1 pending owner invitation(s) were sent by someone who is not an owner of the company — cancel them, or have an owner re-issue them, before applying');
  });

  it.each([
    ['an owner sent it', (c: PoolClient, co: string) => legacy(c, co, p.o)],
    ['it was accepted', (c: PoolClient, co: string) => legacy(c, co, p.a, ', now()')],
  ])('applies when %s', async (_label, poison) => {
    const co = await company(pool, p, companies);
    expect(await applyAfter((c) => poison(c, co).then(() => undefined))).toBe('applied');
  });
});
