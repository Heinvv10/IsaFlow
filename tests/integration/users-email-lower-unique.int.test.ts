/**
 * Migration 999 (admin follow-ups 2026-11-16, Package B): users.email is unique on
 * lower(btrim(email)), and the writers store that form.
 *
 * users_email_key compares exact text, so `X@y` and `x@y` could be two profiles for one mailbox.
 * users_email_lower_key makes the database the guarantee. Pinned here, on real Postgres:
 *   · the index's exact definition;
 *   · a row whose email differs from another's only in case or surrounding spaces is refused
 *     (23505, users_email_lower_key), by INSERT and by UPDATE; stored mixed case is kept;
 *   · 999 refuses, naming the number of groups, while a duplicate exists, and builds nothing;
 *   · 999 builds the index on a clean table, as a non-superuser member of the table's owner
 *     (production's deploy role), and a rerun changes nothing;
 *   · provisionTenant and upsertInviteeProfile store lower(btrim(email)); the helper answers
 *     'email_in_use' for a conflict on the new index (a legacy mixed-case row).
 * Every DDL runs in a transaction that is rolled back.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertDisposableDb } from '../helpers/assertDisposableDb';
import { provisionTenant } from '@/modules/onboarding/services/tenantProvisioningService';
import { upsertInviteeProfile } from '@/lib/auth/inviteeProfile';

assertDisposableDb('999 writes users rows and companies it removes again.');

const INDEX = 'users_email_lower_key';
const INDEX_DEF = 'CREATE UNIQUE INDEX users_email_lower_key ON public.users USING btree (lower(btrim((email)::text)))';
const migration = () => readFileSync(
  path.join(__dirname, '../../scripts/migrations/sql/999_users_email_lower_unique.sql'), 'utf8');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const createdUsers: string[] = [];
const createdCompanies: string[] = [];

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [createdUsers]);
    for (const t of ['fiscal_periods', 'fiscal_years', 'subscriptions']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [createdCompanies]);
    }
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [createdCompanies]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUsers]);
  } finally {
    await pool.end();
  }
}, 60_000);

interface Outcome { code?: string; constraint?: string; message?: string }
const outcome = (e: unknown): Outcome => {
  const err = e as Outcome;
  return { code: err.code, constraint: err.constraint };
};

const addUser = (c: PoolClient | Pool, email: string, id = randomUUID()) => {
  createdUsers.push(id);
  return c.query(`INSERT INTO users (id, email, is_active) VALUES ($1, $2, true)`, [id, email]).then(() => id);
};
const indexDef = async (c: PoolClient | Pool) => (await c.query(
  `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users' AND indexname = $1`, [INDEX])).rows;
const indexOid = async (c: PoolClient) =>
  (await c.query(`SELECT to_regclass('public.${INDEX}')::oid AS oid`)).rows[0].oid as number | null;
const storedEmail = async (id: string) => (await pool.query('SELECT email FROM users WHERE id = $1', [id])).rows[0]?.email;

/** `steps` in a transaction that is always rolled back. */
async function rolledBack(steps: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await steps(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** Runs `text` under a savepoint; the error it raised, if any. */
async function attempt(c: PoolClient, text: string, values: unknown[] = []): Promise<Outcome & { message?: string } | null> {
  await c.query('SAVEPOINT a');
  try {
    await c.query(text, values);
    await c.query('RELEASE SAVEPOINT a');
    return null;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT a');
    return { ...outcome(e), message: (e as Error).message };
  }
}

describe('999: users_email_lower_key', () => {
  it('after 999 users carries a UNIQUE index on lower(btrim(email))', async () => {
    expect(await indexDef(pool)).toEqual([{ indexdef: INDEX_DEF }]);
  });

  it('a second row differing only in case or surrounding spaces is refused (23505 on the new index); the stored case is kept', async () => {
    const tag = randomUUID();
    const held = await addUser(pool, `Held-${tag}@Case.Test`);
    for (const variant of [`held-${tag}@case.test`, `  HELD-${tag}@CASE.TEST `]) {
      const err = await addUser(pool, variant).then(() => null, outcome);
      expect(err).toEqual({ code: '23505', constraint: INDEX });
    }
    const other = await addUser(pool, `other-${tag}@case.test`);
    const err = await pool.query('UPDATE users SET email = $2 WHERE id = $1', [other, `HELD-${tag}@case.test`])
      .then(() => null, outcome);
    expect(err).toEqual({ code: '23505', constraint: INDEX });
    expect(await storedEmail(held)).toBe(`Held-${tag}@Case.Test`);
    expect(await storedEmail(other)).toBe(`other-${tag}@case.test`);
  });

  it('refuses while a duplicate exists, naming the number of groups, and builds nothing', async () => {
    await rolledBack(async (c) => {
      await c.query(`DROP INDEX public.${INDEX}`);
      const tag = randomUUID();
      // Two groups: a case variant and a space variant. No other row can share a normal form (the index held until now).
      await addUser(c, `Dup-${tag}@x.test`);
      await addUser(c, `dup-${tag}@x.test`);
      await addUser(c, ` sp-${tag}@x.test`);
      await addUser(c, `sp-${tag}@x.test`);
      const err = await attempt(c, migration());
      expect(err?.code).toBe('P0001');
      expect(err?.message).toBe(
        '999: 2 group(s) of users rows share an email once lower-cased and trimmed; users_email_lower_key cannot be built');
      expect(err?.message).not.toContain(tag);
      expect(await indexDef(c)).toEqual([]);
    });
  });

  it('builds the index on a clean table as a non-superuser member of the owner (the deploy role); a rerun changes nothing', async () => {
    await rolledBack(async (c) => {
      // Production's shape: users owned by migration_admin, applied by a BYPASSRLS non-superuser that inherits it.
      const deployer = `emailci_deployer_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await c.query(`CREATE ROLE ${deployer} NOSUPERUSER INHERIT BYPASSRLS IN ROLE migration_admin`);
      await c.query('ALTER TABLE public.users OWNER TO migration_admin');
      await c.query(`DROP INDEX public.${INDEX}`);
      await c.query(`SET LOCAL ROLE ${deployer}`);
      expect((await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows).toEqual([{ rolsuper: false }]);
      await c.query(migration());
      await c.query('RESET ROLE');
      expect(await indexDef(c)).toEqual([{ indexdef: INDEX_DEF }]);
      const built = await indexOid(c);
      await c.query(migration());
      expect(await indexOid(c)).toBe(built);
      expect(await indexDef(c)).toEqual([{ indexdef: INDEX_DEF }]);
    });
  });
});

describe('writers store lower(btrim(email))', () => {
  it('provisionTenant: the owner\'s users row, on create and on a re-provision', async () => {
    const userId = randomUUID();
    createdUsers.push(userId);
    const provision = async (email: string) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await provisionTenant(c, {
          ownerUserId: userId, email, firstName: 'Ci', lastName: 'Email',
          companyName: `EMAILCI ${userId}`, phone: null, annualTurnoverCents: null, signupType: 'direct',
        });
        createdCompanies.push(out.companyId);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    };
    await provision(`  Owner-${userId}@Mixed.Test `);
    expect(await storedEmail(userId)).toBe(`owner-${userId}@mixed.test`);
    // A second company for the same owner takes the ON CONFLICT (id) branch, which rewrites email.
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [userId]);
    await provision(`OWNER2-${userId}@Mixed.Test`);
    expect(await storedEmail(userId)).toBe(`owner2-${userId}@mixed.test`);
  });

  describe('upsertInviteeProfile', () => {
    const upsert = async (userId: string, email: string) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await upsertInviteeProfile(c, { userId, email, firstName: 'In', lastName: 'Vitee' });
        await c.query(r === 'ok' ? 'COMMIT' : 'ROLLBACK');
        return r;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    };

    it('a new row stores the invitation\'s address lower-cased and trimmed', async () => {
      const userId = randomUUID();
      createdUsers.push(userId);
      expect(await upsert(userId, ` Invitee-${userId}@Mixed.Test  `)).toBe('ok');
      expect(await storedEmail(userId)).toBe(`invitee-${userId}@mixed.test`);
    });

    it('an existing profile\'s email is not written, even in mixed case', async () => {
      const userId = await addUser(pool, `Kept-${randomUUID()}@Mixed.Test`);
      const before = await storedEmail(userId);
      expect(await upsert(userId, `other-${userId}@mixed.test`)).toBe('ok');
      expect(await storedEmail(userId)).toBe(before);
    });

    it('a legacy row holding the address in mixed case under another id: email_in_use (users_email_lower_key), no row', async () => {
      const tag = randomUUID();
      await addUser(pool, `Legacy-${tag}@Mixed.Test`);
      const userId = randomUUID();
      createdUsers.push(userId);
      expect(await upsert(userId, `legacy-${tag}@mixed.test`)).toBe('email_in_use');
      expect(await storedEmail(userId)).toBeUndefined();
    });
  });
});
