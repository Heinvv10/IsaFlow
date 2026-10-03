/**
 * D10: two-connection interleaving, the brk-d8c harness (D8 adversarial passes 3-4) kept for regression use.
 *
 * A solo run of flow A records every statement it sends. Then, for every LOCK-TAKING statement i of A (FOR UPDATE /
 * SHARE, UPDATE, INSERT, DELETE, lock_timeout set), on a FRESH scenario: A runs on connection 1; right after
 * statement i returns, flow B starts on connection 2; A resumes as soon as B has finished or is WAITING ON A LOCK
 * (pg_stat_activity.wait_event_type = 'Lock', B's pid in this database). Both commit, or roll back on a throw as
 * withAuth does on a 5xx. A row is BAD on a deadlock, a lock timeout, a wait over 4 s, or a violated invariant
 * (not judged on GLREV pairs, below).
 */
import { appendFileSync } from 'fs';
import type { Pool, PoolClient } from 'pg';
import { runOn, type Fixture } from './helpers/l1FifoFixture';

export type Row = Record<string, unknown>;
export interface Scenario {
  flows: Record<string, () => Promise<unknown>>;
  /** null when the document, the GL and every bank line agree; otherwise what disagrees. */
  invariant: () => Promise<string | null>;
}
export interface Outcome { ok: boolean; ms: number; err?: string; code?: string }
export interface Bad { pair: string; k: number; pauseAt: number; stmt: string; a: string; b: string; violation: string | null }

const LOCKING = /\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b|^\s*(UPDATE|INSERT|DELETE)\b|lock_timeout/i;
const strip = (t: string) => t.replace(/--[^\n]*\n/g, '\n').replace(/\s+/g, ' ').trim();
const textOf = (a: unknown[]) => (typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '');

export function classify(o: Outcome): string {
  if (o.ok) return 'ok';
  const s = `${o.code ?? ''} ${o.err ?? ''}`;
  if (/40P01|deadlock/i.test(s)) return 'DEADLOCK';
  if (/55P03|LockTimeout|lock timeout/i.test(s)) return 'LOCK_TIMEOUT';
  return 'refused';
}

async function runFlow(
  fx: Fixture, label: string, fn: () => Promise<unknown>, onQuery?: (i: number, text: string) => Promise<void>,
): Promise<Outcome> {
  const cl: PoolClient = await fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  await orig(`SET application_name = '${label}'`);
  let n = 0;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    if (onQuery) await onQuery(++n, textOf(a));
    return out;
  };
  const t0 = Date.now();
  await orig('BEGIN');
  try {
    await runOn(fx, cl, fn);
    await orig('COMMIT');
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    await orig('ROLLBACK');
    const e = err as { message?: string; code?: unknown; name?: string };
    return { ok: false, ms: Date.now() - t0, code: String(e.code ?? ''), err: `${e.name ?? 'Error'}: ${e.message ?? String(err)}` };
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    await orig("SET application_name = ''");
    cl.release();
  }
}

async function lockPoints(fx: Fixture, s: Scenario, a: string): Promise<{ i: number; text: string }[]> {
  const seen: { i: number; text: string }[] = [];
  // A refusing flow still holds its locks until its transaction ends: its lock points count too.
  await runFlow(fx, 'd10-solo', s.flows[a]!, async (i, t) => { seen.push({ i, text: strip(t) }); });
  return seen.filter((q) => LOCKING.test(q.text) && !/^SAVEPOINT|^RELEASE|^SET application_name/i.test(q.text));
}

async function waitBlockedOrDone(admin: Pool, pid: () => number | null, done: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 7000 && !done()) {
    const p = pid();
    if (p) {
      const { rows } = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [p]);
      if (rows[0]?.wait_event_type === 'Lock') return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function interleave(
  fx: Fixture, admin: Pool, s: Scenario, a: string, b: string, at: number,
): Promise<{ aOut: Outcome; bOut: Outcome; violation: string | null }> {
  let bRun: Promise<Outcome> | null = null;
  let bPid: number | null = null;
  let bDone = false;
  const aOut = await runFlow(fx, 'd10-A', s.flows[a]!, async (i) => {
    if (i !== at || bRun) return;
    bRun = runFlow(fx, 'd10-B', s.flows[b]!).then((o) => { bDone = true; return o; });
    const t0 = Date.now();
    while (!bPid && !bDone && Date.now() - t0 < 3000) {
      const { rows } = await admin.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name = 'd10-B' AND datname = current_database() LIMIT 1");
      if (rows[0]) bPid = Number(rows[0].pid);
      else await new Promise((r) => setTimeout(r, 5));
    }
    await waitBlockedOrDone(admin, () => bPid, () => bDone);
  });
  const bOut: Outcome = bRun ? await bRun : { ok: false, ms: 0, err: 'B never started' };
  return { aOut, bOut, violation: await s.invariant() };
}

/** Every lock point of A against B, both directions, for each k; returns the BAD rows. `make(k)` builds a fresh scenario. */
export async function hunt(opts: {
  fx: Fixture; admin: Pool; ks: number[]; pairs: [string, string][]; make: (k: number) => Promise<Scenario>;
  maxPoints: number;
}): Promise<Bad[]> {
  // One JSON line per interleaving when D10_EVIDENCE names a file: the run's own record, not the assertion.
  const record = (row: object) => { if (process.env.D10_EVIDENCE) appendFileSync(process.env.D10_EVIDENCE, `${JSON.stringify(row)}\n`); };
  const bad: Bad[] = [];
  for (const k of opts.ks) {
    for (const [x, y] of opts.pairs.flatMap(([a, b]) => [[a, b], [b, a]] as const)) {
      const points = (await lockPoints(opts.fx, await opts.make(k), x)).slice(0, opts.maxPoints);
      for (const p of points) {
        const r = await interleave(opts.fx, opts.admin, await opts.make(k), x, y, p.i);
        const row = { pair: `${x}->${y}`, k, pauseAt: p.i, stmt: p.text.slice(0, 140), a: classify(r.aOut),
          b: classify(r.bOut), violation: r.violation, aMs: r.aOut.ms, bMs: r.bOut.ms };
        record(row);
        // A GL reverse of the head leaves the document live by design (the GL screen reverses journals, not
        // documents): those pairs are judged on deadlocks, timeouts and waits only, as brk-d8c judged them.
        const judged = r.violation && !x.startsWith('GLREV') && !y.startsWith('GLREV');
        if (/DEADLOCK|LOCK_TIMEOUT/.test(row.a + row.b) || judged || r.aOut.ms > 4000 || r.bOut.ms > 4000) bad.push(row);
      }
    }
  }
  return bad;
}
