/**
 * WP2-2 (bank transactions audit 2026-11-15): two imports of ONE statement into ONE bank account, overlapped for
 * real. Every import path reads the account's existing lines (the dedup read) and then INSERTs; with nothing
 * serialising two of them, both read before either wrote and the statement landed twice.
 *
 * The overlap is forced, not hoped for: the test file wraps `@/lib/neon`'s `sql` so that the FIRST dedup read
 * pauses (`arm`) until the second import has either read as well — nothing serialised them, and both will insert —
 * or is queued on the account's ingest lock in `pg_locks` — the fix: the first commits, the second then reads its
 * rows. Every wait is bounded. No sleeps decide the outcome; the row count does.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

export interface Race { armed: boolean; reads: number; gate: (() => Promise<void>) | null }

/** The dedup read of every import path: bulk commit, the agent import, the classified import and the OCR commit. */
export const DEDUP_READ = /^\s*SELECT\s+(?:id,\s*)?transaction_date::text AS transaction_date[\s\S]*\bFROM\s+bank_transactions\b/;

/**
 * The feed writer's key, spelt exactly as `bankIngestionPersistence.lockBankAccountForIngest` spelt it before
 * WP2-2. A holder of THIS key must stop every import path, or the paths do not share one lock.
 */
export const ingestKey = (company: string, bank: string) => `bank_tx_ingest:${company}:${bank}`;

const QUEUED = `
  SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
    AND ((classid::int8 << 32) | objid::int8) = hashtextextended($1, 0)`;

/** Arm the race on `key`: the first dedup read waits (at most 10 s) until a second import read too or queued on the key. */
export function arm(race: Race, pool: Pool, key: string): void {
  race.reads = 0;
  race.armed = true;
  race.gate = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (race.reads >= 2) return;
      if ((await pool.query(QUEUED, [key])).rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('race gate: the second import neither read nor queued on the ingest lock within 10 s');
  };
}

export function disarm(race: Race): void {
  race.armed = false;
  race.gate = null;
}

/** Lines on this company's account: the outcome the whole suite is about. */
export async function lineCount(pool: Pool, company: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM bank_transactions WHERE company_id = $1', [company])).rows[0].n;
}

/** Hold the account's ingest key on a third connection, as an import in flight does, until `release` runs. */
export async function holdIngestKey(pool: Pool, company: string, bank: string): Promise<{ release: () => Promise<void> }> {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ingestKey(company, bank)]);
  return {
    release: async () => {
      try { await holder.query('ROLLBACK'); } finally { holder.release(); }
    },
  };
}

/** One request transaction on its own connection, as withAuth / the MCP bearer pipeline open one; COMMIT on success. */
export async function inRequest<T>(pool: Pool, company: string, user: string, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: company, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

/** A three-line generic CSV statement, distinct per `tag`. */
export function statementCsv(tag: string): string {
  return ['Date,Description,Amount',
    `2026-09-08,${tag} rent,-1500.00`, `2026-09-09,${tag} deposit,2400.10`, `2026-09-10,${tag} fee,-35.50`].join('\n');
}
