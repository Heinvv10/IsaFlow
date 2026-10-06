/**
 * NUMRACE cross-year fixture: one company with open 2025 and 2026, an expense account, an auto-post bank rule
 * matching 'NRRULE', and helpers to run the real multi-journal posters on a connection of the test's choosing.
 * Shared by numrace-cross-year*.int.test.ts.
 */
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { runOn, seedBankTx, seedFixture, type Fixture } from './l1FifoFixture';
import { journalInput, openYear } from './jenumFixture';
import { backendPid, settle, waitBlockedBy } from './numraceGate';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';

type Row = Record<string, unknown>;

export interface CrossYear { fx: Fixture; expense: string }

export async function seedCrossYear(prefix: string, databaseUrl: string): Promise<CrossYear> {
  const fx = await seedFixture(prefix, databaseUrl);
  await openYear(fx, 2025);
  const expense = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
    AND account_code = '6000'`) as Row[])[0]!.id);
  await sql`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern,
      gl_account_id, priority, auto_create_entry, vat_code)
    VALUES (${fx.companyId}::UUID, 'NUMRACE rule', 'description', 'contains', 'NRRULE', ${expense}::UUID, 1, true, 'none')`;
  return { fx, expense };
}

export async function dropCrossYear(c: CrossYear): Promise<void> {
  const co = c.fx.companyId;
  await sql`DELETE FROM vat_period_locks WHERE company_id = ${co}::UUID`;
  await sql`UPDATE gl_journal_entries SET late_claim_of_id = NULL, reversal_of_id = NULL WHERE company_id = ${co}::UUID`;
  await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM bank_auto_post_settings WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM bank_auto_post_runs WHERE company_id = ${c.fx.companyId}::UUID`;
}

/** A bank line with an id whose first 8 hex chars fix its position in every id-sorted walk. */
export function line(c: CrossYear, idHead: string, date: string, description: string): Promise<string> {
  return seedBankTx(c.fx, { id: `${idHead}-${crypto.randomUUID().slice(9)}`, date, amount: -10, description });
}

export function toolCtx(c: CrossYear): McpToolContext {
  return { companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:bank-tx', 'write:post'],
    tokenJti: 'numrace', oauthAppId: null };
}

/** bulk_allocate_bank_transactions' handler (the real posting code) with one description per line. */
export function bulkAllocate(c: CrossYear, lines: { id: string; description?: string }[]): Promise<McpToolResult> {
  return bulkAllocateBankTransactionsTool.handler({
    allocations: lines.map((l) => ({ transaction_id: l.id, contra_account_id: c.expense,
      ...(l.description ? { description: l.description } : {}) })),
    idempotency_key: `numrace-${crypto.randomUUID()}`,
  }, toolCtx(c));
}

export const rules = (c: CrossYear) => applyRules(c.fx.companyId, c.fx.bankAccountId, c.fx.userId);

/** A transaction on its own connection: `run` it, then COMMIT on success and ROLLBACK on a throw. */
export interface Txn {
  client: PoolClient; pid: number; run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Rolls back and releases a transaction that was never `run` (a test that failed before it). */
  abandon: () => Promise<void>;
}

export async function txn(c: CrossYear): Promise<Txn> {
  const client = await c.fx.pool.connect();
  const pid = await backendPid(client);
  await client.query('BEGIN');
  let used = false;
  return {
    client, pid,
    abandon: async () => {
      if (used) return;
      used = true;
      await client.query('ROLLBACK').catch(() => undefined);
      client.release(true);
    },
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      used = true;
      try {
        const v = await runOn(c.fx, client, fn);
        await client.query('COMMIT');
        return v;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        // Destroyed, not pooled: a backend that exits flushes its statistics, so pg_stat_database.deadlocks
        // counts a deadlock it was the victim of without waiting for the idle flush.
        client.release(true);
      }
    },
  };
}

/** pg_stat_database.deadlocks for this database, read fresh. */
export async function deadlocks(c: CrossYear): Promise<number> {
  const r = await c.fx.pool.query(`SELECT pg_stat_clear_snapshot(), deadlocks::int AS n
    FROM pg_stat_database WHERE datname = current_database()`);
  return Number(r.rows[0].n);
}

/** Lines that posted (a journal line is matched) among `ids`. */
export async function postedCount(ids: string[]): Promise<number> {
  return Number(((await sql`SELECT COUNT(*)::int AS n FROM bank_transactions
    WHERE id = ANY(${ids}::UUID[]) AND matched_journal_line_id IS NOT NULL`) as Row[])[0]!.n);
}

// The peer holds the first year's key (a journal, uncommitted) and, once the run is waiting on it, numbers the second.
export async function ascendingPeerVs(
  c: CrossYear, run: () => Promise<unknown>, peerDates: [string, string] = ['2025-10-01', '2026-10-01'],
) {
  const before = await deadlocks(c);
  const peer = await txn(c);
  const other = await txn(c);
  let releasePeer!: () => void, holding!: () => void;
  const peerGo = new Promise<void>((r) => { releasePeer = r; });
  const peerHolds = new Promise<void>((r) => { holding = r; });
  try {
    const pPeer = settle(peer.run(async () => {
      await createJournalEntry(c.fx.companyId, journalInput(c.expense, c.fx.bankAccountId, peerDates[0], 5), c.fx.userId);
      holding();
      await peerGo;
      return createJournalEntry(c.fx.companyId, journalInput(c.expense, c.fx.bankAccountId, peerDates[1], 6), c.fx.userId);
    }));
    await peerHolds;
    const pRun = settle(other.run(run));
    await waitBlockedBy(c.fx.pool, peer.pid);
    releasePeer();
    const [rp, rr] = [await pPeer, await pRun];
    await new Promise((r) => setTimeout(r, 1200));
    return { rp, rr, before, after: await deadlocks(c) };
  } finally {
    releasePeer();
    await peer.abandon();
    await other.abandon();
  }
}
