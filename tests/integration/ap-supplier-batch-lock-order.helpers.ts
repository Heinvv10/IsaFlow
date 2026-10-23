/**
 * Shared by the supplier <-> batch lock-order suites: a writer on one request transaction whose backend pid is
 * known (so a lock wait is attributed to it and to no other session), and the statement it is blocked on.
 */
import type { Pool, PoolClient } from 'pg';
import { inRequest } from './r035-pr5.helpers';

export type Outcome = { ok: true } | { ok: false; code: string | undefined };
export const outcomeOf = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ ok: true as const }), (err: { code?: string }) => ({ ok: false as const, code: err.code }));

export function lockOrderKit(pool: Pool, userId: () => string) {
  return {
    /** `fn` on one request transaction; `pid` is its backend. */
    startWriter(c: string, fn: (client: PoolClient) => Promise<unknown>) {
      let gotPid!: (pid: number) => void;
      const pid = new Promise<number>((res) => { gotPid = res; });
      const outcome = outcomeOf(inRequest(pool, userId(), c, async (client) => {
        gotPid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return fn(client);
      }));
      return { pid, outcome };
    },
    /** The statement backend `pid` is blocked on, once it waits on a lock. */
    async blockedStatement(pid: number): Promise<string> {
      for (let i = 0; i < 500; i += 1) {
        const res = await pool.query("SELECT query FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
        if (res.rowCount) return res.rows[0].query as string;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`backend ${pid} never waited on a lock`);
    },
    accountOf: async (id: string) =>
      (await pool.query('SELECT bank_account_number FROM suppliers WHERE id = $1', [id])).rows[0].bank_account_number as string,
  };
}
