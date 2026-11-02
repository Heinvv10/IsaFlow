/**
 * Migration 954 (budgets P5-1): the budget-control tables are tenant-isolated as app_user under
 * forced RLS; budget_check_events cannot be rewritten by the app pools; user_notifications shows a
 * member only their own rows; PO-line dimensions belong to the order's company; the service pool
 * (the cron, app_service with no claims) reaches the new tables through 915's mirrors.
 * Real PostgreSQL; synthetic rows only.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture, type Co } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, amount, asAppUser, codeOf } = budgetVersionFixture(pool);
const memberA2 = crypto.randomUUID();
const supplier: Record<string, string> = {};
const po: Record<string, string> = {};
const versionOf: Record<string, string> = {};

const TENANT_TABLES = ['budget_control_settings', 'budget_alert_thresholds', 'budget_alerts', 'budget_check_events',
  'budget_holders', 'budget_slice_reviews'] as const;
type Table = (typeof TENANT_TABLES)[number] | 'user_notifications';
const rowsOf: Record<string, Record<Table, string>> = {};

/** One row per new table for company `c`, written as the owner; returns their ids (settings: the company id). */
async function seedRows(c: Co, versionId: string): Promise<Record<Table, string>> {
  const one = async (text: string, params: unknown[]) => String((await pool.query(text, params)).rows[0].id);
  return {
    budget_control_settings: await one(
      `INSERT INTO budget_control_settings (company_id, check_policy) VALUES ($1, 'block') RETURNING company_id AS id`, [c.id]),
    budget_alert_thresholds: await one(
      `INSERT INTO budget_alert_thresholds (company_id, gl_account_id, cc1_id, thresholds, created_by)
       VALUES ($1, $2, $3, '{90}', $4) RETURNING id`, [c.id, c.acct, c.cc1, c.user]),
    budget_alerts: await one(
      `INSERT INTO budget_alerts (company_id, version_id, gl_account_id, month, threshold, budget, actual, committed, pct)
       VALUES ($1, $2, $3, '2026-03-01', 100, 10, 11, 0, 110) RETURNING id`, [c.id, versionId, c.acct]),
    budget_check_events: await one(
      `INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, channel, decided_by)
       VALUES ($1, 'purchase_order', $3, 'warn', 'warn', '[]', 'ui', $2) RETURNING id`, [c.id, c.user, po[c.id]]),
    budget_holders: await one(
      `INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, gl_account_ids, created_by)
       VALUES ($1, $2, $3, $4, ARRAY[$5]::UUID[], $3) RETURNING id`, [c.id, versionId, c.user, c.cc1, c.acct]),
    budget_slice_reviews: await one(
      `INSERT INTO budget_slice_reviews (company_id, version_id, bu_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [c.id, versionId, c.bu, c.user]),
    user_notifications: await one(
      `INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key, href)
       VALUES ($1, $2, 'budget_alert', 'Rent over budget', 'k1', '/accounting/budgets') RETURNING id`, [c.id, c.user]),
  };
}

const idCol = (t: Table) => (t === 'budget_control_settings' ? 'company_id' : 'id');

beforeAll(async () => {
  await setup();
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [memberA2, `${memberA2}@test.local`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'manager')", [A.id, memberA2]);
  for (const c of [A, B]) {
    versionOf[c.id] = await version(c, { primary: true });
    supplier[c.id] = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, $3)', [supplier[c.id], c.id, 'P5 supplier']);
    po[c.id] = String((await pool.query(
      `INSERT INTO purchase_orders (company_id, po_number, supplier_id, order_date, status)
       VALUES ($1, 'P5-PO-1', $2, '2026-03-10', 'approved') RETURNING id`, [c.id, supplier[c.id]])).rows[0].id);
    rowsOf[c.id] = await seedRows(c, versionOf[c.id]!);
  }
  // A second member of A has a notification of their own.
  await pool.query(`INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key)
                    VALUES ($1, $2, 'budget_alert', 'Manager row', 'k1')`, [A.id, memberA2]);
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM purchase_orders WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM user_notifications WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM budget_check_events WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM budget_control_settings WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM budget_alert_thresholds WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [memberA2]);
    await cleanup();
    await pool.query('DELETE FROM users WHERE id = $1', [memberA2]);
  } finally { await pool.end(); }
});

/** As withAuth opens a request for `user` in company `co`; always rolled back. */
async function asMember<T>(co: string, user: string, fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('954: forced RLS on every new table', () => {
  it.each([...TENANT_TABLES, 'user_notifications'] as Table[])('%s: RLS enabled and forced, 944 predicate', async (t) => {
    const r = (await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT string_agg(pg_get_expr(p.polqual, p.polrelid) || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), ' | ')
                 FROM pg_policy p WHERE p.polrelid = c.oid AND 'app_user'::regrole = ANY (p.polroles)) AS quals
         FROM pg_class c WHERE c.oid = $1::regclass`, [t])).rows[0];
    expect(r.relrowsecurity).toBe(true);
    expect(r.relforcerowsecurity).toBe(true);
    expect(r.quals).toContain('app.current_company_id()');
    expect(r.quals).toContain('auth.user_companies()');
  });

  it.each([...TENANT_TABLES, 'user_notifications'] as Table[])("%s: A's session reads, changes and deletes none of B's rows", async (t) => {
    const bId = rowsOf[B.id]![t];
    await asAppUser(A, async (q) => {
      expect((await q.query(`SELECT COUNT(*)::int n FROM ${t} WHERE ${idCol(t)} = $1`, [bId])).rows[0].n).toBe(0);
      // A refused privilege (42501) is a refusal too; a visible row would be rowCount 1.
      for (const stmt of [`UPDATE ${t} SET company_id = company_id WHERE ${idCol(t)} = $1`, `DELETE FROM ${t} WHERE ${idCol(t)} = $1`]) {
        const res = await codeOf(q, stmt, [bId]);
        expect(['ok', '42501']).toContain(res);
      }
      expect((await q.query(`SELECT COUNT(*)::int n FROM ${t} WHERE ${idCol(t)} = $1`, [rowsOf[A.id]![t]])).rows[0].n).toBe(1);
    });
    expect((await pool.query(`SELECT COUNT(*)::int n FROM ${t} WHERE ${idCol(t)} = $1 AND company_id = $2`, [bId, B.id])).rows[0].n).toBe(1);
  });

  it("A's session cannot insert a row carrying B's company_id, nor point an A row at B's account, centre or version", async () => {
    const refused = /^(42501|23514|23503)/;
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, `INSERT INTO budget_control_settings (company_id) VALUES ($1)`, [B.id])).toMatch(refused);
      expect(await codeOf(q, `INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, channel, decided_by)
        VALUES ($1, 'purchase_order', gen_random_uuid(), 'warn', 'pass', '[]', 'ui', 'x')`, [B.id])).toMatch(refused);
      expect(await codeOf(q, `INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key)
        VALUES ($1, $2, 'budget_alert', 't', 'x')`, [B.id, B.user])).toMatch(refused);
      expect(await codeOf(q, `INSERT INTO budget_alert_thresholds (company_id, gl_account_id, thresholds, created_by)
        VALUES ($1, $2, '{80}', 'x')`, [A.id, B.acct])).toBe('23514');
      expect(await codeOf(q, `INSERT INTO budget_alert_thresholds (company_id, gl_account_id, cc1_id, thresholds, created_by)
        VALUES ($1, $2, $3, '{80}', 'x')`, [A.id, A.acct, B.cc1])).toMatch(/^23503/);
      expect(await codeOf(q, `INSERT INTO budget_holders (company_id, version_id, user_id, gl_account_ids, created_by)
        VALUES ($1, $2, $3, ARRAY[$4]::UUID[], 'x')`, [A.id, versionOf[A.id], A.user, B.acct])).toBe('23514');
      // A CC2 centre is not a CC1 (947's kind check on the slice tables).
      expect(await codeOf(q, `INSERT INTO budget_alert_thresholds (company_id, gl_account_id, cc1_id, thresholds, created_by)
        VALUES ($1, $2, $3, '{80}', 'x')`, [A.id, A.acct2, A.cc2])).toBe('23514');
      // The control: A's own references are accepted.
      expect(await codeOf(q, `INSERT INTO budget_alert_thresholds (company_id, gl_account_id, cc1_id, thresholds, created_by)
        VALUES ($1, $2, $3, '{80}', 'x')`, [A.id, A.acct2, A.cc1])).toBe('ok');
    });
  });
});

describe('954: budget_check_events is insert-only for the app pools', () => {
  it('app_user inserts and reads its own company\'s events but can neither UPDATE nor DELETE one', async () => {
    const own = rowsOf[A.id]!.budget_check_events;
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, `INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, reason, channel, decided_by)
        VALUES ($1, 'purchase_order', $3, 'block', 'override', '[]', 'owner said so', 'ui', $2)`, [A.id, A.user, po[A.id]])).toBe('ok');
      expect(await codeOf(q, `UPDATE budget_check_events SET reason = 'rewritten' WHERE id = $1`, [own])).toBe('42501');
      expect(await codeOf(q, `UPDATE budget_check_events SET outcome = 'pass' WHERE id = $1`, [own])).toBe('42501');
      expect(await codeOf(q, `DELETE FROM budget_check_events WHERE id = $1`, [own])).toBe('42501');
      // Ids and the stamp take their defaults.
      expect(await codeOf(q, `INSERT INTO budget_check_events (id, company_id, document_type, document_id, policy, outcome, lines, channel, decided_by)
        VALUES (gen_random_uuid(), $1, 'supplier_invoice', gen_random_uuid(), 'warn', 'warn', '[]', 'ui', 'x')`, [A.id])).toBe('42501');
      expect(await codeOf(q, `INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, channel, decided_by, decided_at)
        VALUES ($1, 'supplier_invoice', gen_random_uuid(), 'warn', 'warn', '[]', 'ui', 'x', now() - interval '1 year')`, [A.id])).toBe('42501');
    });
    const r = await pool.query('SELECT reason, outcome FROM budget_check_events WHERE id = $1', [own]);
    expect(r.rows[0]).toEqual({ reason: null, outcome: 'warn' });
  });

  it('the service pool (app_service) cannot rewrite an event either', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_service');
      await expect(client.query(`UPDATE budget_check_events SET reason = 'x' WHERE id = $1`, [rowsOf[A.id]!.budget_check_events]))
        .rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('954: user_notifications are each member\'s own', () => {
  it('a member reads and marks only their own rows; another member\'s rows are invisible', async () => {
    await asMember(A.id, A.user, async (q) => {
      const r = await q.query('SELECT user_id, title FROM user_notifications ORDER BY title');
      expect(r.rows).toEqual([{ user_id: A.user, title: 'Rent over budget' }]);
      expect((await q.query(`UPDATE user_notifications SET read_at = now() WHERE user_id = $1`, [memberA2])).rowCount).toBe(0);
      expect((await q.query(`UPDATE user_notifications SET read_at = now() WHERE user_id = $1`, [A.user])).rowCount).toBe(1);
      // Only read_at is writable.
      expect(await codeOf(q, `UPDATE user_notifications SET user_id = $1`, [memberA2])).toBe('42501');
      expect(await codeOf(q, `UPDATE user_notifications SET title = 'x'`)).toBe('42501');
      expect(await codeOf(q, `DELETE FROM user_notifications`)).toBe('42501');
      // A notification for another member of the company may be written (an evaluator notifies owners), never read back.
      expect(await codeOf(q, `INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key)
        VALUES ($1, $2, 'budget_slice', 'Submitted', 'k2')`, [A.id, memberA2])).toBe('ok');
      expect((await q.query('SELECT COUNT(*)::int n FROM user_notifications WHERE user_id = $1', [memberA2])).rows[0].n).toBe(0);
    });
    await asMember(A.id, memberA2, async (q) => {
      const r = await q.query('SELECT user_id, title FROM user_notifications');
      expect(r.rows).toEqual([{ user_id: memberA2, title: 'Manager row' }]);
    });
  });

  it('a link is an in-app path only', async () => {
    await asAppUser(A, async (q) => {
      const ins = (href: string) => codeOf(q, `INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key, href)
        VALUES ($1, $2, 'budget_alert', 't', $3, $4)`, [A.id, A.user, crypto.randomUUID(), href]);
      expect(await ins('https://evil.example')).toBe('23514:user_notifications_href_check');
      expect(await ins('//evil.example/x')).toBe('23514:user_notifications_href_check');
      expect(await ins('/\\evil.example')).toBe('23514:user_notifications_href_check');
      expect(await ins('javascript:alert(1)')).toBe('23514:user_notifications_href_check');
      expect(await ins('/accounting/budgets?x=1')).toBe('ok');
    });
  });
});

describe('954: PO line dimensions', () => {
  const line = (q: PoolClient | Pool, poId: string, dims: { cc1?: string; cc2?: string; bu?: string }) => codeOf(q as PoolClient,
    `INSERT INTO po_items (purchase_order_id, description, quantity, unit_price, line_total, cc1_id, cc2_id, bu_id)
     VALUES ($1, 'x', 1, 10, 10, $2, $3, $4)`, [poId, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null]);

  it("belong to the order's company and are of their kind, as app_user and as the owner", async () => {
    await asAppUser(A, async (q) => {
      expect(await line(q, po[A.id]!, { cc1: B.cc1 })).toMatch(/^23503/);
      expect(await line(q, po[A.id]!, { bu: B.bu })).toMatch(/^23503/);
      expect(await line(q, po[A.id]!, { cc1: A.cc2 })).toBe('23514');
      expect(await line(q, po[A.id]!, { cc2: A.cc1 })).toBe('23514');
      expect(await line(q, po[A.id]!, { cc1: A.cc1, cc2: A.cc2, bu: A.bu })).toBe('ok');
      expect(await line(q, po[A.id]!, {})).toBe('ok');
    });
    const owner = await pool.connect();
    try {
      await owner.query('BEGIN');
      expect(await line(owner, po[A.id]!, { cc1: B.cc1 })).toBe('23503');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });
});

describe('954: the service pool (cron) reaches the new tables', () => {
  it('app_service with no claims reads every company\'s alerts, notifications and budget amounts, and writes notifications', async () => {
    await amount(A, versionOf[A.id]!, { amount: 42 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_service');
      const n = async (t: string) => (await client.query(`SELECT COUNT(*)::int n FROM ${t} WHERE company_id = ANY($1)`, [[A.id, B.id]])).rows[0].n;
      expect(await n('budget_alerts')).toBe(2);
      expect(await n('user_notifications')).toBe(3);
      expect(await n('budget_month_amounts')).toBe(1);
      expect(await n('budget_control_settings')).toBe(2);
      await client.query(`INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key)
                          VALUES ($1, $2, 'budget_alert', 'cron', 'cron-1')`, [B.id, B.user]);
      await client.query(`UPDATE budget_alerts SET resolved_at = now() WHERE company_id = $1`, [B.id]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('no app_service mirror is missing or extra (915b drift is empty for the new tables)', async () => {
    const r = await pool.query(`SELECT why, tbl::text AS tbl, what FROM public.app_service_policy_drift()
      WHERE tbl::text = ANY($1)`, [[...TENANT_TABLES, 'user_notifications']]);
    expect(r.rows).toEqual([]);
  });
});
