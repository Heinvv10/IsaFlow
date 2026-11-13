/**
 * Migration 954, review round 2 (PR #1066): the rules the first review found missing, as app_user
 * under forced RLS and as the service pool. A notification link with a control character or space,
 * a notification for a non-member, a forged review / event / alert stamp, an event naming another
 * company's document, and a centre kind change under a PO line or an alert are all refused or
 * overwritten; 954 applies twice without error or drift. Real PostgreSQL; synthetic rows only.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, asAppUser, codeOf } = budgetVersionFixture(pool);
const manager = crypto.randomUUID();
const outsider = crypto.randomUUID();
const doc: Record<string, { bill: string; po: string; sup: string }> = {};
let vA = '';

beforeAll(async () => {
  await setup();
  for (const u of [manager, outsider]) {
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [u, `${u}@test.local`]);
  }
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'manager'), ($3, $4, 'owner')",
    [A.id, manager, B.id, outsider]);
  vA = await version(A, { primary: true });
  for (const c of [A, B]) {
    const sup = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, $3)', [sup, c.id, 'R2 supplier']);
    const bill = String((await pool.query(`INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, created_by, status)
      VALUES ($1, 'R2-B', $2, '2026-04-01', 0, 0, $3, 'draft') RETURNING id`, [c.id, sup, c.user])).rows[0].id);
    const po = String((await pool.query(`INSERT INTO purchase_orders (company_id, po_number, supplier_id, status) VALUES ($1, 'R2-PO', $2, 'draft') RETURNING id`,
      [c.id, sup])).rows[0].id);
    doc[c.id] = { bill, po, sup };
  }
}, 120_000);
afterAll(async () => {
  try {
    const ids = [A.id, B.id];
    for (const t of ['user_notifications', 'budget_check_events', 'budget_alerts', 'budget_slice_reviews', 'purchase_orders', 'supplier_invoices', 'suppliers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [ids]);
    }
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::TEXT[])', [[manager, outsider]]);
    await cleanup();
    await pool.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[manager, outsider]]);
  } finally { await pool.end(); }
});

/** A request as withAuth opens one for `user` in company `co`, or the service pool's `role` with no claims; rolled back. */
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
const note = (q: PoolClient, user: string, href: string | null = null, co = A.id) => codeOf(q,
  `INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key, href) VALUES ($1, $2, 'budget_alert', 't', $3, $4)`,
  [co, user, crypto.randomUUID(), href]);

describe('954 r2: a notification link has no control character or space anywhere', () => {
  it.each([['tab', '/\t/evil.com'], ['LF', '/\n/evil.com'], ['CR', '/\r/evil.com'], ['space', '/ /evil.com'],
    ['DEL', '/\x7f/evil.com'], ['trailing tab', '/accounting\t'], ['C1 control', '/a\u0085b']])('%s is refused as app_user', async (_n, href) => {
    await asAppUser(A, async (q) => expect(await note(q, A.user, href)).toBe('23514:user_notifications_href_check'));
  });
  it('NUL cannot reach the column at all (Postgres text refuses it)', async () => {
    await asAppUser(A, async (q) => expect(await note(q, A.user, '/\u0000/evil.com')).toMatch(/^22/));
  });
  it('a plain in-app path is accepted', async () => {
    await asAppUser(A, async (q) => expect(await note(q, A.user, '/accounting/budgets?tab=alerts#x')).toBe('ok'));
  });
});

describe('954 r2: a notification goes to a member of the company only', () => {
  it('as app_user: a non-member or another company\'s user is refused; a manager may notify the owner', async () => {
    await asRole('app_user', { user: manager, co: A.id }, async (q) => {
      expect(await note(q, outsider)).toBe('23503');
      expect(await note(q, B.user)).toBe('23503');
      expect(await note(q, 'nobody-at-all')).toBe('23503');
      // The manager cannot see the owner's membership row (cu_self_or_admin); 714's reviewed definer answers.
      expect((await q.query('SELECT COUNT(*)::int n FROM company_users WHERE user_id = $1', [A.user])).rows[0].n).toBe(0);
      expect(await note(q, A.user)).toBe('ok');
    });
  });

  it.each(['app_service', 'isaflow_service'])('the cron\'s role %s (no claims) inserts for a member and is refused for a non-member', async (role) => {
    // isaflow_service is the service pool's login (915; src/lib/neon.AGENTS.md): it inherits app_service.
    await asRole(role, null, async (q) => {
      expect(await note(q, A.user)).toBe('ok');
      expect(await note(q, outsider)).toBe('23503');
      expect((await q.query(`SELECT COUNT(*)::int n FROM user_notifications WHERE company_id = $1 AND user_id = $2`, [A.id, A.user])).rows[0].n).toBe(1);
    });
  });
});

describe('954 r2: actor and time stamps are the session\'s, never the caller\'s', () => {
  it('slice review: stamps cannot be written; a status move stamps the session user and the clock', async () => {
    const id = await asAppUser(A, async (q) => {
      const r = await q.query(`INSERT INTO budget_slice_reviews (company_id, version_id, bu_id, created_by) VALUES ($1, $2, $3, 'forged') RETURNING id, created_by`,
        [A.id, vA, A.bu]);
      expect(r.rows[0].created_by).toBe(A.user);
      for (const col of ['submitted_by', 'submitted_at', 'decided_by', 'decided_at']) {
        const v = col.endsWith('_at') ? '2000-01-01' : 'forged';
        expect(await codeOf(q, `UPDATE budget_slice_reviews SET ${col} = $2 WHERE id = $1`, [r.rows[0].id, v])).toBe('42501');
      }
      // Only a holder of the slice submits it (955, P5-6): the owner holds it here.
      await q.query(`INSERT INTO budget_holders (company_id, version_id, user_id, bu_id, created_by) VALUES ($1, $2, $3, $4, 'x')
                     ON CONFLICT ON CONSTRAINT budget_holders_one_per_slice DO NOTHING`, [A.id, vA, A.user, A.bu]);
      await q.query(`UPDATE budget_slice_reviews SET status = 'submitted' WHERE id = $1`, [r.rows[0].id]);
      const s = (await q.query('SELECT submitted_by, submitted_at > now() - interval \'1 minute\' AS fresh FROM budget_slice_reviews WHERE id = $1', [r.rows[0].id])).rows[0];
      expect(s).toEqual({ submitted_by: A.user, fresh: true });
      await q.query(`UPDATE budget_slice_reviews SET status = 'returned', decision_note = 'redo' WHERE id = $1`, [r.rows[0].id]);
      const d = (await q.query('SELECT decided_by, submitted_by, decided_at IS NOT NULL AS stamped FROM budget_slice_reviews WHERE id = $1', [r.rows[0].id])).rows[0];
      expect(d).toEqual({ decided_by: A.user, submitted_by: A.user, stamped: true });
      return String(r.rows[0].id);
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('check event: decided_by is the session user whatever is sent; the document must be the company\'s', async () => {
    await asAppUser(A, async (q) => {
      const ins = (type: string, docId: string, by: string | null) => q.query(
        `INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, channel${by === null ? '' : ', decided_by'})
         VALUES ($1, $2, $3, 'warn', 'warn', '[]', 'ui'${by === null ? '' : ', $4'}) RETURNING id`, by === null ? [A.id, type, docId] : [A.id, type, docId, by]);
      const forged = await ins('supplier_invoice', doc[A.id]!.bill, 'someone-else');
      const omitted = await ins('purchase_order', doc[A.id]!.po, null);
      const rows = (await q.query('SELECT decided_by FROM budget_check_events WHERE id = ANY($1)', [[forged.rows[0].id, omitted.rows[0].id]])).rows;
      expect(rows.map((r) => r.decided_by)).toEqual([A.user, A.user]);
      for (const [type, docId] of [['supplier_invoice', doc[B.id]!.bill], ['purchase_order', doc[B.id]!.po],
        ['supplier_invoice', doc[A.id]!.po], ['purchase_order', crypto.randomUUID()]] as const) {
        expect(await codeOf(q, `INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, channel)
          VALUES ($1, $2, $3, 'warn', 'warn', '[]', 'ui')`, [A.id, type, docId])).toBe('23503');
      }
      expect(await codeOf(q, `INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, channel)
        VALUES ($1, 'supplier_invoice', $2, 'warn', 'warn', '{}', 'ui')`, [A.id, doc[A.id]!.bill])).toBe('23514:budget_check_events_lines_check');
    });
  });

  it('alert: fired_at is not writable; resolving stamps the clock, re-firing re-stamps fired_at', async () => {
    await asAppUser(A, async (q) => {
      const a = (await q.query(`INSERT INTO budget_alerts (company_id, version_id, gl_account_id, month, threshold, budget, actual, committed, pct)
        VALUES ($1, $2, $3, '2026-03-01', 100, 10, 11, 0, 110) RETURNING id, fired_at::TEXT AS fired_at`, [A.id, vA, A.acct])).rows[0];
      expect(await codeOf(q, `UPDATE budget_alerts SET fired_at = '2000-01-01' WHERE id = $1`, [a.id])).toBe('42501');
      await q.query(`UPDATE budget_alerts SET resolved_at = '2000-01-01' WHERE id = $1`, [a.id]);
      const r = (await q.query('SELECT resolved_at > now() - interval \'1 minute\' AS fresh, fired_at = $2::TIMESTAMPTZ AS same FROM budget_alerts WHERE id = $1', [a.id, a.fired_at])).rows[0];
      expect(r).toEqual({ fresh: true, same: true });
      await q.query(`UPDATE budget_alerts SET resolved_at = NULL WHERE id = $1`, [a.id]);
      const f = (await q.query('SELECT resolved_at, fired_at > $2::TIMESTAMPTZ AS refired FROM budget_alerts WHERE id = $1', [a.id, a.fired_at])).rows[0];
      expect(f).toEqual({ resolved_at: null, refired: true });
    });
  });
});

describe('954 r2: a centre under a PO line or an alert keeps its kind', () => {
  it('po_items and budget_alerts both hold the kind', async () => {
    const owner = await pool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(`INSERT INTO po_items (purchase_order_id, description, quantity, unit_price, line_total, cc1_id) VALUES ($1, 'x', 1, 1, 1, $2)`,
        [doc[A.id]!.po, A.cc1]);
      expect(await codeOf(owner, `UPDATE cost_centres SET cc_type = 'cc2' WHERE id = $1`, [A.cc1])).toBe('23514');
      await owner.query(`INSERT INTO budget_alerts (company_id, version_id, gl_account_id, cc1_id, month, threshold, budget, actual, committed, pct)
        VALUES ($1, $2, $3, $4, '2026-03-01', 100, 10, 11, 0, 110)`, [A.id, vA, A.acct, A.cc1b]);
      expect(await codeOf(owner, `UPDATE cost_centres SET cc_type = 'cc2' WHERE id = $1`, [A.cc1b])).toBe('23514');
      // The control: an unused centre may change.
      expect(await codeOf(owner, `UPDATE cost_centres SET cc_type = 'cc1' WHERE id = $1`, [A.cc2])).toBe('ok');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });
});

describe('954 r2: re-run safety', () => {
  it('applies twice more on a database that has it, without error and without changing its catalog', async () => {
    const text = readFileSync('scripts/migrations/sql/954_budget_controls.sql', 'utf8');
    const snap = (q: PoolClient) => q.query(`SELECT
        (SELECT string_agg(v, ',' ORDER BY v) FROM (SELECT polrelid::regclass || '.' || polname AS v FROM pg_policy
          WHERE polrelid::regclass::text IN ('budget_control_settings','budget_alert_thresholds','budget_alerts','user_notifications',
                                             'budget_check_events','budget_holders','budget_slice_reviews')) s) AS policies,
        (SELECT string_agg(v, ',' ORDER BY v) FROM (SELECT tgrelid::regclass || '.' || tgname || ':' || tgenabled::text AS v FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('budget_control_settings','budget_alert_thresholds','budget_alerts',
            'user_notifications','budget_check_events','budget_holders','budget_slice_reviews','po_items','cost_centres')) s) AS triggers,
        (SELECT string_agg(v, ',' ORDER BY v) FROM (SELECT table_name || '.' || column_name || ':' || privilege_type AS v FROM information_schema.column_privileges
          WHERE grantee = 'app_user' AND table_name IN ('budget_control_settings','budget_alert_thresholds','budget_alerts','user_notifications',
                                                        'budget_check_events','budget_holders','budget_slice_reviews')) s) AS grants`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = (await snap(client)).rows[0];
      await client.query(text);
      await client.query(text);
      expect((await snap(client)).rows[0]).toEqual(before);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
