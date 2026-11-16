/**
 * Migration 999c: sars_compliance_events as app_user. A mark is tenant-isolated under forced RLS
 * (944's predicate), its actor and time stamps are the trigger's (a forged value is overwritten), a
 * mark with no session user is refused, app_user cannot UPDATE, and one period takes one mark (23505).
 * Real PostgreSQL; synthetic rows only.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const mk = () => ({ id: crypto.randomUUID(), user: crypto.randomUUID() });
const A = mk(), B = mk();
let rowB = '';

const INSERT = `INSERT INTO sars_compliance_events (company_id, event_type, due_date, period_end, description, status, sars_reference)
                VALUES ($1, $2, '2026-03-06', '2026-02-28', 'EMP201 for February 2026', 'completed', $3) RETURNING id, filed_by, filed_at`;

beforeAll(async () => {
  for (const c of [A, B]) {
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [c.id, `Filed ${c.id.slice(0, 8)}`]);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [c.user, `${c.user}@test.local`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [c.id, c.user]);
  }
  // B's mark, written as B's member so the stamp trigger has a session user.
  rowB = await as(B, async (q) => String((await q.query(INSERT, [B.id, 'EMP201_DUE', null])).rows[0].id), true);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM sars_compliance_events WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[A.user, B.user]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[A.id, B.id]]);
  } finally { await pool.end(); }
});

/** A transaction as withAuth opens one for `c`'s member in company `co` (default: c's own). Rolled back unless `commit`. */
async function as<T>(c: { id: string; user: string }, fn: (q: PoolClient) => Promise<T>, commit = false, co = c.id): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: c.user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
    const out = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

/** The SQLSTATE (and constraint) a statement fails with, or 'ok'. */
async function codeOf(q: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await q.query('SAVEPOINT p');
  try {
    await q.query(text, params);
    await q.query('RELEASE SAVEPOINT p');
    return 'ok';
  } catch (err) {
    await q.query('ROLLBACK TO SAVEPOINT p');
    const e = err as { code?: string; constraint?: string };
    return e.constraint ? `${e.code}:${e.constraint}` : String(e.code);
  }
}

describe('999c: tenancy', () => {
  it('RLS enabled and forced, with the 944 predicate on USING and WITH CHECK', async () => {
    const r = (await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_expr(p.polqual, p.polrelid) q, pg_get_expr(p.polwithcheck, p.polrelid) w
         FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
        WHERE c.oid = 'sars_compliance_events'::regclass`)).rows[0];
    expect(r.relrowsecurity).toBe(true);
    expect(r.relforcerowsecurity).toBe(true);
    for (const e of [r.q, r.w]) {
      expect(e).toContain('app.current_company_id()');
      expect(e).toContain('auth.user_companies()');
    }
  });

  it("A's session reads none of B's marks and deletes none", async () => {
    await as(A, async (q) => {
      expect((await q.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE id = $1', [rowB])).rows[0].n).toBe(0);
      expect((await q.query('DELETE FROM sars_compliance_events WHERE id = $1', [rowB])).rowCount).toBe(0);
    });
    expect((await pool.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE id = $1', [rowB])).rows[0].n).toBe(1);
  });

  it("A's session cannot write a mark into B's company", async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, INSERT, [B.id, 'VAT201_DUE', null])).toBe('42501');
    });
  });

  it("A's member with B active (not a member of B) reads none of B's marks", async () => {
    await as(A, async (q) => {
      expect((await q.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE company_id = $1', [B.id])).rows[0].n).toBe(0);
    }, false, B.id);
  });

  it("a member of both companies, with A active, reads and deletes none of B's marks", async () => {
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [B.id, A.user]);
    try {
      await as(A, async (q) => {
        expect((await q.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE id = $1', [rowB])).rows[0].n).toBe(0);
        expect((await q.query('DELETE FROM sars_compliance_events WHERE id = $1', [rowB])).rowCount).toBe(0);
      });
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [B.id, A.user]);
    }
  });

  it("B's own session reads its mark", async () => {
    await as(B, async (q) => {
      expect((await q.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE id = $1', [rowB])).rows[0].n).toBe(1);
    });
  });
});

describe('999c: stamps and privileges', () => {
  it('filed_by and filed_at cannot be sent (column privileges)', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, `INSERT INTO sars_compliance_events (company_id, event_type, due_date, period_end, description, filed_by)
                              VALUES ($1, 'VAT201_DUE', '2026-03-25', '2026-02-28', 'x', 'someone-else')`, [A.id])).toBe('42501');
      expect(await codeOf(q, `INSERT INTO sars_compliance_events (company_id, event_type, due_date, period_end, description, filed_at)
                              VALUES ($1, 'VAT201_DUE', '2026-03-25', '2026-02-28', 'x', '2020-01-01')`, [A.id])).toBe('42501');
    });
  });

  it('the trigger stamps the session user and the clock', async () => {
    await as(A, async (q) => {
      const r = (await q.query(INSERT, [A.id, 'VAT201_DUE', 'REF-1'])).rows[0];
      expect(r.filed_by).toBe(A.user);
      expect(Math.abs(new Date(r.filed_at).getTime() - Date.now())).toBeLessThan(60_000);
    });
  });

  it('a forged filed_by from a privileged writer is overwritten by the session user', async () => {
    await as(A, async (q) => {
      await q.query('RESET ROLE');
      const r = (await q.query(
        `INSERT INTO sars_compliance_events (company_id, event_type, due_date, period_end, description, filed_by, filed_at)
         VALUES ($1, 'VAT201_DUE', '2026-03-25', '2026-02-28', 'x', 'forged', '2020-01-01') RETURNING filed_by, filed_at`, [A.id])).rows[0];
      expect(r.filed_by).toBe(A.user);
      expect(new Date(r.filed_at).getUTCFullYear()).toBeGreaterThan(2020);
    });
  });

  it('a mark with no session user is refused', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await codeOf(c, `INSERT INTO sars_compliance_events (company_id, event_type, due_date, period_end, description)
                              VALUES ($1, 'VAT201_DUE', '2026-03-25', '2026-02-28', 'x')`, [A.id])).toBe('42501');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('app_user cannot UPDATE a mark', async () => {
    await as(B, async (q) => {
      expect(await codeOf(q, "UPDATE sars_compliance_events SET status = 'pending' WHERE id = $1", [rowB])).toBe('42501');
      expect(await codeOf(q, "UPDATE sars_compliance_events SET filed_by = 'x' WHERE id = $1", [rowB])).toBe('42501');
    });
  });

  it('a second mark of one period is 23505 on the period key', async () => {
    await as(B, async (q) => {
      expect(await codeOf(q, INSERT, [B.id, 'EMP201_DUE', null])).toBe('23505:uq_sars_compliance_events_period');
      // A different type with the same period is its own mark.
      expect(await codeOf(q, INSERT, [B.id, 'VAT201_DUE', null])).toBe('ok');
    });
  });

  it('a blank or over-long reference is refused', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, INSERT, [A.id, 'EMP501_DUE', '  '])).toBe('23514:sars_compliance_events_reference_shape');
      expect(await codeOf(q, INSERT, [A.id, 'EMP501_DUE', 'x'.repeat(101)])).toBe('23514:sars_compliance_events_reference_shape');
    });
  });
});
