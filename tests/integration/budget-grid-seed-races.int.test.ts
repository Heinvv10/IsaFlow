/**
 * Budgets P2 create wizard under concurrency (round-1 findings BRK-L3/ARCH-M1, BRK-L2): a seed takes
 * every version row lock it needs FOR UPDATE, in one statement ordered by (fiscal_year, id),
 * before it reads anything of its source. So two make-primary copies of one source queue instead
 * of deadlocking (each used to hold FOR SHARE on the source and then wait for FOR UPDATE on it),
 * the source cannot be deleted under a copy (which answered 200 with an empty version), and a
 * source deleted before the seed takes it is a 404 with nothing created. Two make-primary seeds in
 * a year with no version yet have no row to queue on: the later one is a clean 409, nothing kept.
 * And the seed's savepoint
 * (round-1 QA-M1): a refusal raised after the version and its amounts are inserted, with the
 * transaction still usable, is a 4xx that withAuth COMMITS, so only the savepoint keeps it empty.
 * Real PostgreSQL through the real routes; statements are hooked, never faked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

type RawSql = ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) & Record<string, unknown>;
const hooks = vi.hoisted(() => ({ match: null as null | RegExp, fn: null as null | (() => Promise<void>), fired: 0 }));

// Every statement runs on the real database; once armed, `fn` runs right after the first statement matching `match`.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as RawSql;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { match, fn } = hooks;
    if (!match || !fn || !match.test(strings.join('?'))) return realSql(strings, ...values);
    return (async () => {
      hooks.match = null;
      hooks.fn = null;
      hooks.fired += 1;
      const rows = await realSql(strings, ...values);
      await fn();
      return rows;
    })();
  };
  Object.assign(sql, realSql);
  return { ...real, sql };
});

import seedRoute from '../../pages/api/accounting/budget-grid/seed';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo, type RouteOut } from './helpers/budgetGridFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
let A: GridCo;

beforeAll(async () => { A = await fx.company(); }, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const seed = (b: unknown) => fx.call(seedRoute, '/api/accounting/budget-grid/seed', A.owner, 'POST', {}, b);
const copy = (name: string, versionId: string, upliftPct: number, makePrimary = false) =>
  ({ fiscalYear: 2027, name, kind: 'reforecast', makePrimary, roundingUnit: 1, source: { type: 'version', versionId, upliftPct } });
const dump = (r: { status: number; body: unknown }) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const created = (r: RouteOut) => (r.body.data as { versionId?: string } | undefined)?.versionId;
const amountRows = async (id: string) => Number((await pool.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE version_id = $1', [id])).rows[0].n);
const named = async (name: string) => Number((await pool.query('SELECT COUNT(*)::int n FROM budget_versions WHERE company_id = $1 AND name = $2', [A.id, name])).rows[0].n);

/** Polls until another backend waits on a lock while running a statement matching `like`; returns it. */
async function waitForLockWaiter(like = '%FROM budget_versions%', ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = (await pool.query(
      `SELECT pid, left(query, 120) q FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()`, [like])).rows;
    if (r[0]) return r[0] as { pid: number; q: string };
    await new Promise((res) => setTimeout(res, 25));
  }
  return null;
}

/** Deletes the version from another connection, waiting at most 300 ms for its row lock; the error code, or 'deleted'. */
async function tryDelete(versionId: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '300ms'`);
    await client.query('DELETE FROM budget_versions WHERE id = $1', [versionId]);
    await client.query('COMMIT');
    return 'deleted';
  } catch (err) {
    await client.query('ROLLBACK');
    return String((err as { code?: string }).code);
  } finally {
    client.release();
  }
}

describe('seed: version row locks', () => {
  it('two make-primary copies (+10%) of one source queue, never deadlock: both 200, the later one primary', async () => {
    const src = await fx.version(A, { name: 'R1-src', kind: 'original', primary: true });
    await fx.amounts(A, src, A.acct.rent, FY27, 100);
    let waiter: { q: string } | null = null;
    let second: Promise<RouteOut> | null = null;
    hooks.fired = 0;
    // Right after the first seed's first row lock on budget_versions, the second seed starts and must wait.
    hooks.match = /FROM budget_versions[\s\S]*FOR (SHARE|UPDATE)/;
    hooks.fn = async () => {
      second = seed(copy('R1-b', src, 10, true));
      waiter = await waitForLockWaiter();
    };
    const first = await seed(copy('R1-a', src, 10, true));
    const later = await second!;
    expect(hooks.fired).toBe(1);
    expect(waiter, 'the second seed waited on a version row lock').not.toBeNull();
    expect([first.status, later.status], `${dump(first)} | ${dump(later)}`).toEqual([200, 200]);
    const primary = (await pool.query(`SELECT name FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2027 AND is_primary`, [A.id])).rows;
    expect(primary).toEqual([{ name: 'R1-b' }]);
    expect([await amountRows(created(first)!), await amountRows(created(later)!)]).toEqual([12, 12]);
  });

  it('the source cannot be deleted while a copy reads it: the copy is whole', async () => {
    const src = await fx.version(A, { name: 'R2-src' });
    await fx.amounts(A, src, A.acct.rent, FY27, 100);
    let deletion = '';
    hooks.fired = 0;
    // getVersion: before the fix the copy read its source here, before it held it.
    hooks.match = /FROM budget_versions v\s+WHERE v\.id = /;
    hooks.fn = async () => { deletion = await tryDelete(src); };
    const r = await seed(copy('R2', src, 10));
    expect(hooks.fired).toBe(1);
    expect(r.status, dump(r)).toBe(200);
    expect(deletion).toBe('55P03');
    expect(await amountRows(created(r)!)).toBe(12);
  });

  it('a source deleted before the seed takes it is 404 BUDGET_VERSION_NOT_FOUND, with no version created', async () => {
    for (const pct of [10, 0]) {
      const src = await fx.version(A, { name: `R3-src-${pct}` });
      await fx.amounts(A, src, A.acct.rent, FY27, 100);
      hooks.fired = 0;
      hooks.match = /pg_advisory_xact_lock_shared/;
      hooks.fn = async () => { expect(await tryDelete(src)).toBe('deleted'); };
      const r = await seed(copy(`R3-${pct}`, src, pct));
      expect(hooks.fired).toBe(1);
      expect([r.status, r.body.error?.details?.code], dump(r)).toEqual([404, 'BUDGET_VERSION_NOT_FOUND']);
      expect(await named(`R3-${pct}`)).toBe(0);
    }
  });

  it('a 4xx refusal after the version and its amounts are inserted (transaction still usable) leaves no version, amount or audit row', async () => {
    const src = await fx.version(A, { name: 'SP-src' });
    await fx.amounts(A, src, A.acct.rent, FY27, 100);
    hooks.fired = 0;
    // Thrown in JS right after the seed's amounts insert succeeds: no database error, so nothing aborts the transaction.
    hooks.match = /INSERT INTO budget_month_amounts/;
    hooks.fn = async () => { throw new BudgetVersionError('BUDGET_VERSION_STATE', 'injected refusal after the amounts insert'); };
    const before = Number((await pool.query('SELECT COUNT(*)::int n FROM audit_log WHERE company_id = $1', [A.id])).rows[0].n);
    const r = await seed(copy('SP-copy', src, 10));
    expect(hooks.fired).toBe(1);
    expect([r.status, r.body.error?.details?.code], dump(r)).toEqual([409, 'BUDGET_VERSION_STATE']);
    expect(await named('SP-copy')).toBe(0);
    expect(Number((await pool.query('SELECT COUNT(*)::int n FROM audit_log WHERE company_id = $1', [A.id])).rows[0].n)).toBe(before);
  });

  it('two make-primary seeds in a year with no version: the one that loses the primary is 409 BUDGET_VERSION_STATE, nothing of it kept', async () => {
    const blank = (name: string) => ({ fiscalYear: 2028, name, kind: 'scenario', makePrimary: true, roundingUnit: 1, source: { type: 'blank' } });
    expect(Number((await pool.query('SELECT COUNT(*)::int n FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2028', [A.id])).rows[0].n)).toBe(0);
    let waiter: { q: string } | null = null;
    let second: Promise<RouteOut> | null = null;
    hooks.fired = 0;
    // Right after the first seed makes its new version primary (uncommitted), the second seed runs and must wait on it.
    hooks.match = /UPDATE budget_versions SET is_primary = true/;
    hooks.fn = async () => {
      second = seed(blank('P2-b'));
      waiter = await waitForLockWaiter('%SET is_primary = true%');
    };
    const first = await seed(blank('P2-a'));
    const later = await second!;
    expect(hooks.fired).toBe(1);
    expect(waiter, 'the second seed waited on the first primary').not.toBeNull();
    expect(first.status, dump(first)).toBe(200);
    expect([later.status, later.body.error?.details?.code], dump(later)).toEqual([409, 'BUDGET_VERSION_STATE']);
    expect(String(later.body.error?.message)).toContain('FY2028');
    expect(await named('P2-b')).toBe(0);
    const audit = await pool.query(`SELECT COUNT(*)::int n FROM audit_log WHERE company_id = $1 AND entity_ref LIKE '%P2-b%'`, [A.id]);
    expect(audit.rows[0].n).toBe(0);
    const primary = (await pool.query(`SELECT name FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2028 AND is_primary`, [A.id])).rows;
    expect(primary).toEqual([{ name: 'P2-a' }]);
  });
});
