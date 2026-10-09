/**
 * R-035 N1b (C, migration 883), section 0 (adversarial review of PR #691,
 * F1): an `owner` invitation an admin sent before 883 — the route allowed it
 * until this PR — would stay live, its token the admin's; and `invited_by`
 * proves nothing (it was writable too). 883 refuses to apply while ANY
 * unaccepted, unexpired owner invitation exists. Run against poisoned states
 * inside one rolled-back transaction, as the deploy role.
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

const REFUSED = 'migration 883: 1 pending owner invitation(s) exist and may have been sent or rewritten by a non-owner — cancel them before applying; an owner re-issues them afterwards';

describe('migration 883 section 0', () => {
  it.each([
    ['an admin sent it', (c: PoolClient, co: string) => legacy(c, co, p.a)],
    // invited_by was writable before 883: naming an owner proves nothing.
    ['it names an owner as its sender', (c: PoolClient, co: string) => legacy(c, co, p.o)],
  ])('refuses while a live owner invitation exists — %s', async (_label, poison) => {
    const co = await company(pool, p, companies);
    expect(await applyAfter((c) => poison(c, co).then(() => undefined))).toBe(REFUSED);
  });

  it.each([
    ['it was accepted', (c: PoolClient, co: string) => legacy(c, co, p.a, ', now()')],
    ['it has expired', (c: PoolClient, co: string) => c.query(
      `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
       VALUES($1,'old@n1bc.test','owner',$2,$3, now() - interval '1 day')`, [co, p.a, tokenHash(crypto.randomUUID())])],
    ['it is for a lesser role', (c: PoolClient, co: string) => c.query(
      `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
       VALUES($1,'mgr@n1bc.test','manager',$2,$3, now() + interval '7 days')`, [co, p.a, tokenHash(crypto.randomUUID())])],
  ])('applies when %s', async (_label, poison) => {
    const co = await company(pool, p, companies);
    expect(await applyAfter((c) => poison(c, co).then(() => undefined))).toBe('applied');
  });
});
