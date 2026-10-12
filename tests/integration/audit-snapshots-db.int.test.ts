/**
 * Forensic-controls step 4, migration 890 — the tables themselves:
 *  - written only through the SECURITY DEFINER writers, bound to the caller
 *    (auth.uid(), the company GUC, the transaction's now(), the role a trigger
 *    needs: manual owner / admin, on lock owner / admin / manager);
 *  - append-only for every role (the owner's plain statements included),
 *    purge cascade only;
 *  - read by owner / admin / manager of the company only (RLS);
 *  - a check run is the company's own and a snapshot cites only its company's run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, asApp, members, newCompany, outcome } from './entity-changes.helpers';
import { cleanupAudit, payload, recordSnapshot } from './audit-snapshots.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '', v = '', x = '';
const TABLES = ['audit_snapshots', 'audit_snapshot_tb', 'audit_snapshot_journals', 'audit_snapshot_lines',
  'audit_check_runs', 'audit_check_results'];

beforeAll(async () => { [o, a, m, v, x] = await members(pool, tokens, 5); });
afterAll(() => cleanupAudit(pool, companies, [o, a, m, v, x]));

const company = () => newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer']], companies);
const rows = {
  tb: [{ account_id: crypto.randomUUID(), row: { closing: '1.00' } }],
  journals: [{ journal_id: crypto.randomUUID(), entry_date: '2026-06-01', row: { id: 'j' }, material_hash: 'c'.repeat(64) }],
  lines: [{ line_id: crypto.randomUUID(), journal_id: crypto.randomUUID(), row: { id: 'l' }, material_hash: 'd'.repeat(64) }],
};
const take = (user: string, c: string, extra: Parameters<typeof payload>[3] = {}) =>
  recordSnapshot(pool, user, c, (t) => payload(c, user, t, extra), rows);

async function recordRun(user: string, c: string, purpose = 'standalone', company = c): Promise<string> {
  return asApp(pool, user, c, async (db) => {
    const { rows: [now] } = await db.query<{ t: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`);
    const run = { id: crypto.randomUUID(), company_id: company, as_at: '2026-06-30', period_start: '2026-03-01',
      taken_at: now!.t, taken_by: user, purpose, canonical_hash: 'e'.repeat(64), hmac: 'f'.repeat(64), key_id: 'k1', totals: {} };
    const results = [{ check_id: 'journal_risk.backdated_entry', check_version: 1, family: 'journal_risk', status: 'fail',
      population: 3, finding_count: 1, findings: [{ key: 'k', refs: ['r'], detail: {} }] }];
    const { rows: [out] } = await db.query<{ id: string }>('SELECT public.audit_check_run_record($1::jsonb,$2::jsonb) AS id',
      [JSON.stringify(run), JSON.stringify(results)]);
    return out!.id;
  });
}

describe('writing', () => {
  it('owner and admin take a manual snapshot; manager and viewer may not; manager may on a lock', async () => {
    const c = await company();
    for (const u of [o, a]) expect(await outcome(take(u, c))).toBe('ok');
    expect(await outcome(take(m, c))).toMatch(/^42501/);
    expect(await outcome(take(v, c))).toMatch(/^42501/);
    expect(await outcome(take(m, c, { trigger: 'period_close' }))).toBe('ok');
    expect(await outcome(take(v, c, { trigger: 'vat_lock' }))).toMatch(/^42501/);
    const { rows: [n] } = await pool.query(
      `SELECT count(*)::int AS s, (SELECT count(*)::int FROM audit_snapshot_lines WHERE company_id = $1) AS l
       FROM audit_snapshots WHERE company_id = $1`, [c]);
    expect(n).toEqual({ s: 3, l: 3 });
  });

  it('binds the row to the caller: taken_by, company, now() and the channel come from the request', async () => {
    const c = await company();
    const other = await company();
    expect(await outcome(recordSnapshot(pool, o, c, (t) => payload(c, a, t), rows))).toMatch(/^42501/);
    expect(await outcome(recordSnapshot(pool, o, c, (t) => payload(other, o, t), rows))).toMatch(/^42501/);
    expect(await outcome(recordSnapshot(pool, o, c, () => payload(c, o, '2026-01-01T00:00:00.000000Z'), rows))).toMatch(/^22023/);
    expect(await outcome(recordSnapshot(pool, o, c, (t) => payload(c, o, t), rows, null))).toMatch(/^42501/);
    const id = await recordSnapshot(pool, o, c, (t) => payload(c, o, t), rows, { sub: o });
    const { rows: [s] } = await pool.query('SELECT taken_by, channel, status FROM audit_snapshots WHERE id = $1', [id]);
    expect(s).toEqual({ taken_by: o, channel: 'token', status: 'sealed' });
  });

  it('a failed attempt carries a reason and no rows or seal; a sealed one carries its seal', async () => {
    const c = await company();
    const failed = { status: 'failed', failure_reason: 'too_large', canonical_hash: null, hmac: null, key_id: null };
    expect(await outcome(recordSnapshot(pool, o, c, (t) => payload(c, o, t, failed)))).toBe('ok');
    expect(await outcome(recordSnapshot(pool, o, c, (t) => payload(c, o, t, failed), rows))).toMatch(/^22023/);
    expect(await outcome(recordSnapshot(pool, o, c, (t) => payload(c, o, t, { hmac: null }), rows))).toMatch(/^23514/);
  });

  it('nobody inserts, updates, deletes or truncates directly — not app_user, not the owner', async () => {
    const c = await company();
    const id = await take(o, c, { check_run_id: await recordRun(o, c) });
    for (const t of TABLES) {
      expect(await outcome(asApp(pool, o, c, (db) => db.query(`INSERT INTO ${t}(company_id) VALUES($1)`, [c])))).toMatch(/^42501/);
      expect(await outcome(asApp(pool, o, c, (db) => db.query(`DELETE FROM ${t}`)))).toMatch(/^42501/);
      expect(await outcome(asApp(pool, o, c, (db) => db.query(`TRUNCATE ${t}`)))).toMatch(/^42501/);
      expect(await outcome(pool.query(`UPDATE ${t} SET company_id = company_id WHERE company_id = $1`, [c]))).toMatch(/^42501/);
      expect(await outcome(pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [c]))).toMatch(/^42501/);
    }
    expect(await outcome(pool.query('TRUNCATE audit_snapshot_lines'))).toMatch(/^42501/);
    const { rows: [s] } = await pool.query('SELECT count(*)::int AS n FROM audit_snapshot_journals WHERE snapshot_id = $1', [id]);
    expect(s.n).toBe(1);
  });

  it('platform_admin and PUBLIC hold no write grant and cannot execute the writers', async () => {
    const { rows: grants } = await pool.query(
      `SELECT r AS role, t, p FROM unnest(ARRAY['platform_admin','app_user']) r, unnest($1::text[]) t,
         unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) p
       WHERE has_table_privilege(r, 'public.' || t, p)`, [TABLES]);
    expect(grants).toEqual([]);
    const { rows: [f] } = await pool.query(
      `SELECT has_function_privilege('platform_admin', 'public.audit_snapshot_record(jsonb,jsonb,jsonb,jsonb)', 'EXECUTE') AS pa,
              has_function_privilege('app_user', 'public.audit_snapshot_record(jsonb,jsonb,jsonb,jsonb)', 'EXECUTE') AS au,
              has_function_privilege('platform_admin', 'public.audit_check_run_record(jsonb,jsonb)', 'EXECUTE') AS pr`);
    expect(f).toEqual({ pa: false, au: true, pr: false });
  });

  it('a company purge takes its snapshots and runs with it', async () => {
    const c = await newCompany(pool, [[o, 'owner']]);
    const run = await recordRun(o, c);
    await take(o, c, { check_run_id: run });
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM companies WHERE id = $1', [c]);
    for (const t of TABLES) {
      const { rows: [n] } = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`, [c]);
      expect(n.n, t).toBe(0);
    }
  });
});

describe('check runs', () => {
  it('standalone runs are owner / admin; a snapshot may cite only its own company’s run', async () => {
    const c = await company();
    const other = await newCompany(pool, [[o, 'owner']], companies);
    expect(await outcome(recordRun(o, c))).toBe('ok');
    expect(await outcome(recordRun(m, c))).toMatch(/^42501/);
    expect(await outcome(recordRun(m, c, 'snapshot'))).toBe('ok');
    expect(await outcome(recordRun(o, c, 'standalone', other))).toMatch(/^42501/);
    const foreign = await recordRun(o, other);
    expect(await outcome(take(o, c, { check_run_id: foreign }))).toMatch(/^(23503|42501)/);
    const own = await recordRun(o, c);
    expect(await outcome(take(o, c, { check_run_id: own }))).toBe('ok');
  });
});

describe('reading', () => {
  it('owner, admin and manager of the company read; a viewer and an outsider read nothing', async () => {
    const c = await company();
    await newCompany(pool, [[x, 'owner']], companies);
    const run = await recordRun(o, c);
    await take(o, c, { check_run_id: run });
    const count = (u: string) => asApp(pool, u, c, async (db) => {
      const out: Record<string, number> = {};
      for (const t of TABLES) out[t] = (await db.query(`SELECT 1 FROM ${t}`)).rowCount ?? 0;
      return out;
    });
    for (const u of [o, a, m]) expect(Object.values(await count(u)).every((n) => n > 0), u).toBe(true);
    for (const u of [v, x]) expect(Object.values(await count(u)).every((n) => n === 0), u).toBe(true);
    // The GUC alone is not membership.
    const forged = await as(pool, x, { company: c }, (db) => db.query('SELECT 1 FROM audit_snapshots'));
    expect(forged.rowCount).toBe(0);
  });
});
