/**
 * NUMRACE: stop a real writer at a chosen point with its transaction open, so a second writer can be started
 * against it. Shared by the numrace-*.int.test.ts files.
 *
 * A test-only AFTER INSERT trigger (`numrace_gate`, installed on the table under test and dropped after) takes
 * `pg_advisory_xact_lock(4242, k)` when the inserted row's named text column contains `ngate:<k>`. The test holds
 * that gate on its own connection first, so the writer whose row carries the marker mints its number, inserts,
 * and then waits on the gate holding everything it took. Every wait is proved with `pg_blocking_pids`, scoped
 * by pid. No sleep decides an outcome. The two-int advisory key space (4242, k) is disjoint from the
 * single-bigint keys the app uses.
 */
import type { Pool, PoolClient } from 'pg';

export interface Gate { client: PoolClient; pid: number; open: () => Promise<void> }

export async function installGate(pool: Pool, table: string, column: string): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.numrace_gate() RETURNS trigger LANGUAGE plpgsql AS $f$
    DECLARE k int;
    BEGIN
      k := substring(to_jsonb(NEW) ->> TG_ARGV[0] from 'ngate:([0-9]+)')::int;
      IF k IS NOT NULL THEN PERFORM pg_advisory_xact_lock(4242, k); END IF;
      RETURN NULL;
    END $f$`);
  await pool.query(`DROP TRIGGER IF EXISTS numrace_gate ON public.${table}`);
  await pool.query(`CREATE TRIGGER numrace_gate AFTER INSERT ON public.${table}
    FOR EACH ROW EXECUTE FUNCTION public.numrace_gate('${column}')`);
}

export async function dropGate(pool: Pool, table: string): Promise<void> {
  await pool.query(`DROP TRIGGER IF EXISTS numrace_gate ON public.${table}`);
}

export async function backendPid(client: PoolClient): Promise<number> {
  return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
}

/** Holds gate `k` until `open()`. */
export async function holdGate(pool: Pool, k: number): Promise<Gate> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(4242, $1)', [k]);
  const pid = await backendPid(client);
  let done = false;
  return {
    client, pid,
    open: async () => {
      if (done) return;
      done = true;
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    },
  };
}

/** Holds one app advisory key, exactly as `take_number_lock` / the 857 trigger hash it, until `release()`. */
export async function holdKey(pool: Pool, scope: string, seed: number): Promise<Gate> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))', [scope, seed]);
  const pid = await backendPid(client);
  let done = false;
  return {
    client, pid,
    open: async () => {
      if (done) return;
      done = true;
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    },
  };
}

/** The pid of a backend that `blocker` is blocking, once one exists (polls; throws after `ms`). */
export async function waitBlockedBy(pool: Pool, blocker: number, ms = 15000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const r = await pool.query(
      'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) ORDER BY pid LIMIT 1', [blocker]);
    if (r.rows[0]) return Number(r.rows[0].pid);
    if (Date.now() - t0 > ms) throw new Error(`nothing became blocked by pid ${blocker} within ${ms} ms`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

/** Waits until `pid` is blocked by anything; returns its blockers. */
export async function waitBlocked(pool: Pool, pid: number, ms = 15000): Promise<number[]> {
  const t0 = Date.now();
  for (;;) {
    const r = await pool.query('SELECT pg_blocking_pids($1) AS b', [pid]);
    const b = (r.rows[0]?.b ?? []) as number[];
    if (b.length > 0) return b;
    if (Date.now() - t0 > ms) throw new Error(`pid ${pid} did not block within ${ms} ms`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

export type Settled<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({
      ok: false as const,
      code: String((e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code ?? ''),
      message: e instanceof Error ? e.message : String(e),
    }));
}
