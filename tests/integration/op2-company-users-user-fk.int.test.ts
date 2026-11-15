/**
 * OP-2 (admin audit 2026-11-14): company_users.user_id names a users row.
 *
 * Migration 996 adds company_users_user_id_fkey -> users(id), NOT VALID (step 1 of 2:
 * production holds one orphan membership today, so VALIDATE waits) and DEFERRABLE
 * INITIALLY DEFERRED: checked at COMMIT, because the tenant writers insert the
 * membership BEFORE the users row in one transaction (provisionTenant, invite accept
 * for a new member), and deleteUser deletes the users row before its final membership
 * sweep (adminUserActionsService).
 *
 * Pinned here, on real Postgres:
 *   · the constraint's exact shape (NO ACTION, deferred, not validated);
 *   · a membership for a user that does not exist is refused at COMMIT (23503) and
 *     nothing is stored;
 *   · membership first, users row second, in one transaction, commits;
 *   · deleting a users row a membership still names is refused; deleting the users
 *     row and then sweeping the membership in one transaction commits;
 *   · an orphan written before the FK is left alone: the migration applies over it
 *     (no scan), and the orphan's role can still be changed;
 *   · the migration is idempotent.
 * Every DDL runs in a transaction that is rolled back.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableDb } from '../helpers/assertDisposableDb';

assertDisposableDb('OP-2 writes companies, users and memberships it removes again.');

const FK = 'company_users_user_id_fkey';
const FK_DEF = 'FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED NOT VALID';
const migration = () => readFileSync(
  path.join(__dirname, '../../scripts/migrations/sql/996_company_users_user_fk_not_valid.sql'), 'utf8');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = randomUUID();
const member = randomUUID();
const orphan = randomUUID();
const createdUsers: string[] = [];

interface Outcome { code?: string; constraint?: string }

/** Runs `steps` in one transaction and commits; the failure, if any, as code + constraint. */
async function inTx(steps: (c: PoolClient) => Promise<void>): Promise<Outcome> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await steps(c);
    await c.query('COMMIT');
    return {};
  } catch (err) {
    await c.query('ROLLBACK');
    const e = err as { code?: string; constraint?: string };
    return { code: e.code, constraint: e.constraint };
  } finally {
    c.release();
  }
}

const addUser = async (c: PoolClient | Pool, id: string) => {
  createdUsers.push(id);
  await c.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@op2.test`]);
};
const addMembership = (c: PoolClient | Pool, userId: string, role = 'viewer') =>
  c.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [company, userId, role]);
const memberships = async (userId: string) =>
  (await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, userId])).rows;
const constraintState = async (c: PoolClient | Pool) => (await c.query(
  `SELECT convalidated, condeferrable, condeferred, confupdtype, confdeltype, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE conname = $1 AND conrelid = 'company_users'::regclass`, [FK])).rows;

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, `OP-2 ${company}`]);
  // An orphan as production holds one: written with the RI triggers off, as if before the FK.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await addMembership(c, orphan, 'owner');
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}, 60_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUsers]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
  } finally {
    await pool.end();
  }
}, 60_000);

describe('OP-2 company_users.user_id -> users(id)', () => {
  it('the FK is NO ACTION, deferred to COMMIT and not validated', async () => {
    expect(await constraintState(pool)).toEqual([{
      convalidated: false, condeferrable: true, condeferred: true, confupdtype: 'a', confdeltype: 'a', def: FK_DEF,
    }]);
  });

  it('a membership for a user that does not exist is refused at COMMIT and nothing is stored', async () => {
    const ghost = randomUUID();
    expect(await inTx(c => addMembership(c, ghost).then(() => undefined))).toEqual({ code: '23503', constraint: FK });
    expect(await memberships(ghost)).toEqual([]);
  });

  it('membership first and the users row second, in one transaction, commits (provisionTenant / invite accept order)', async () => {
    const fresh = randomUUID();
    createdUsers.push(fresh);
    expect(await inTx(async c => { await addMembership(c, fresh, 'owner'); await addUser(c, fresh); })).toEqual({});
    expect(await memberships(fresh)).toEqual([{ role: 'owner' }]);
  });

  it('deleting a users row a membership still names is refused; nothing is deleted', async () => {
    await addUser(pool, member);
    await addMembership(pool, member);
    expect(await inTx(c => c.query('DELETE FROM users WHERE id = $1', [member]).then(() => undefined)))
      .toEqual({ code: '23503', constraint: FK });
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [member])).rowCount).toBe(1);
  });

  it('memberships first, then the users row, then a final sweep, in one transaction, commits (deleteUser order)', async () => {
    const leaving = randomUUID();
    await addUser(pool, leaving);
    await addMembership(pool, leaving);
    expect(await inTx(async c => {
      await c.query('DELETE FROM company_users WHERE user_id = $1', [leaving]);
      await c.query('DELETE FROM users WHERE id = $1', [leaving]);
      // A membership a concurrent add-to-company committed meanwhile; deleteUser sweeps it.
      await addMembership(c, leaving);
      await c.query('DELETE FROM company_users WHERE user_id = $1', [leaving]);
    })).toEqual({});
    expect(await memberships(leaving)).toEqual([]);
  });

  it('an existing orphan is untouched (NOT VALID) and its role can still change', async () => {
    expect(await memberships(orphan)).toEqual([{ role: 'owner' }]);
    expect(await inTx(c => c.query(
      `UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2`, [company, orphan],
    ).then(() => undefined))).toEqual({});
    expect(await memberships(orphan)).toEqual([{ role: 'admin' }]);
  });

  it('the migration applies over an orphan without validating, and a rerun changes nothing', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE company_users DROP CONSTRAINT ${FK}`);
      expect(await constraintState(c)).toEqual([]);
      await c.query(migration());
      const once = await constraintState(c);
      await c.query(migration());
      expect(await constraintState(c)).toEqual(once);
      expect(once).toEqual([{
        convalidated: false, condeferrable: true, condeferred: true, confupdtype: 'a', confdeltype: 'a', def: FK_DEF,
      }]);
      expect((await c.query('SELECT 1 FROM company_users WHERE company_id = $1 AND user_id = $2', [company, orphan])).rowCount)
        .toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
