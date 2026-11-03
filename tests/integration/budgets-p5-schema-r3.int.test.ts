/**
 * Migration 954, review round 3 (PR #1066): the actor stamps on settings, thresholds and holders
 * are the session user's whatever is sent; only an owner, admin or manager may notify another
 * member from a request (the service pool, with no claims, may); a slice moved back to submitted
 * loses the previous decision. As app_user under forced RLS. Real PostgreSQL; synthetic rows only.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, asAppUser, codeOf } = budgetVersionFixture(pool);
const manager = crypto.randomUUID();
const viewer = crypto.randomUUID();
let vA = '';

beforeAll(async () => {
  await setup();
  for (const u of [manager, viewer]) {
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [u, `${u}@test.local`]);
  }
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'viewer')", [A.id, manager, viewer]);
  vA = await version(A, { primary: true });
}, 120_000);
afterAll(async () => {
  try {
    for (const t of ['user_notifications', 'budget_control_settings', 'budget_alert_thresholds', 'budget_holders', 'budget_slice_reviews']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[A.id, B.id]]);
    }
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::TEXT[])', [[manager, viewer]]);
    await cleanup();
    await pool.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[manager, viewer]]);
  } finally { await pool.end(); }
});

async function asRole<T>(role: string, claims: { user: string; co: string } | null, fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    if (claims) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [claims.co]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('954 r3: actor stamps on settings, thresholds and holders are the session user\'s', () => {
  it('budget_control_settings: updated_by forged on insert and on update is overwritten', async () => {
    await asAppUser(A, async (q) => {
      await q.query(`INSERT INTO budget_control_settings (company_id, updated_by) VALUES ($1, 'forged')`, [A.id]);
      expect((await q.query('SELECT updated_by FROM budget_control_settings WHERE company_id = $1', [A.id])).rows[0].updated_by).toBe(A.user);
      await q.query(`UPDATE budget_control_settings SET check_policy = 'block', updated_by = 'forged-2' WHERE company_id = $1`, [A.id]);
      expect((await q.query('SELECT updated_by FROM budget_control_settings WHERE company_id = $1', [A.id])).rows[0].updated_by).toBe(A.user);
    });
  });

  it('budget_alert_thresholds: created_by and updated_by forged are overwritten', async () => {
    await asAppUser(A, async (q) => {
      const id = String((await q.query(`INSERT INTO budget_alert_thresholds (company_id, gl_account_id, thresholds, created_by)
        VALUES ($1, $2, '{90}', 'forged') RETURNING id`, [A.id, A.acct])).rows[0].id);
      await q.query(`UPDATE budget_alert_thresholds SET thresholds = '{95}', updated_by = 'forged-2' WHERE id = $1`, [id]);
      expect((await q.query('SELECT created_by, updated_by FROM budget_alert_thresholds WHERE id = $1', [id])).rows[0])
        .toEqual({ created_by: A.user, updated_by: A.user });
    });
  });

  it('budget_holders: created_by forged is overwritten', async () => {
    await asAppUser(A, async (q) => {
      const r = await q.query(`INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by)
        VALUES ($1, $2, $3, $4, 'forged') RETURNING created_by`, [A.id, vA, manager, A.cc1]);
      expect(r.rows[0].created_by).toBe(A.user);
    });
  });
});

describe('954 r3: who may notify another member', () => {
  const note = (q: PoolClient, to: string) => codeOf(q,
    `INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key) VALUES ($1, $2, 'budget_slice', 't', $3)`,
    [A.id, to, crypto.randomUUID()]);

  it('a viewer is refused; a manager and an owner may; the service pool with no claims may', async () => {
    await asRole('app_user', { user: viewer, co: A.id }, async (q) => {
      expect(await note(q, A.user)).toBe('42501');
      expect(await note(q, viewer)).toBe('42501');
    });
    await asRole('app_user', { user: manager, co: A.id }, async (q) => expect(await note(q, A.user)).toBe('ok'));
    await asRole('app_user', { user: A.user, co: A.id }, async (q) => expect(await note(q, manager)).toBe('ok'));
    await asRole('isaflow_service', null, async (q) => expect(await note(q, viewer)).toBe('ok'));
  });
});

describe('954 r3: a slice moved back to submitted loses the previous decision', () => {
  it('returned → submitted clears decided_by, decided_at and the decision note', async () => {
    await asAppUser(A, async (q) => {
      const id = String((await q.query(`INSERT INTO budget_slice_reviews (company_id, version_id, bu_id, created_by)
        VALUES ($1, $2, $3, 'x') RETURNING id`, [A.id, vA, A.bu])).rows[0].id);
      await q.query(`UPDATE budget_slice_reviews SET status = 'submitted' WHERE id = $1`, [id]);
      await q.query(`UPDATE budget_slice_reviews SET status = 'returned', decision_note = 'Too high' WHERE id = $1`, [id]);
      expect((await q.query('SELECT decided_by FROM budget_slice_reviews WHERE id = $1', [id])).rows[0].decided_by).toBe(A.user);
      await q.query(`UPDATE budget_slice_reviews SET status = 'submitted' WHERE id = $1`, [id]);
      expect((await q.query('SELECT status, decided_by, decided_at, decision_note, submitted_by FROM budget_slice_reviews WHERE id = $1', [id])).rows[0])
        .toEqual({ status: 'submitted', decided_by: null, decided_at: null, decision_note: null, submitted_by: A.user });
    });
  });
});
