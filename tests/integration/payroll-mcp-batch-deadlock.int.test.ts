/**
 * Two MCP JSON-RPC batches (one request transaction each). A post takes the company approval lock, then the run's
 * header (payrollRunLock.ts order 1, 2), and its journal then takes the company-wide journal-numbering advisory lock
 * (3). A batch that already created a journal WITHOUT the approval lock (any other writer: here a direct create,
 * as a manual journal would) holds 3; its next post wants 1 again, which inverts the single call's order, so
 * Postgres kills one batch with 40P01. (Two batches that both POST serialise on the company lock instead: the
 * second test.) That victim
 * is answered by the registry's central 40P01 mapping as a retryable refusal (not GENERIC_FAILURE), and once retried on its own every run
 * ends with exactly one journal. Every call goes through the REAL registry (its savepoint is what un-aborts the
 * batch's transaction): after the victim's refusal a further query and a further call on the SAME transaction
 * succeed. The further call is a dry run, not a post: the victim's row lock on the run header it lost on is only
 * released to the survivor when its transaction ends (Postgres keeps a released savepoint's row locks queued on the
 * parent), so a victim that went on to take the numbering lock again would deadlock the survivor a second time.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { McpRegistry } from '@/lib/mcp/registry';
import { postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import { GENERIC_FAILURE } from '@/lib/mcp/thrownToolErrorText';
import { rig } from './brkr.helpers';

type ToolOut = { isError?: boolean; content: Array<{ text: string }> };
let r: Awaited<ReturnType<typeof rig>>;
const registry = new McpRegistry();
registry.register(postPayrollJournalTool);
beforeAll(async () => { r = await rig('batchdl'); await r.setup(); await r.employee(20000); });
afterAll(async () => { await r.teardown(); });

const ctx = () => ({ companyId: r.company, userId: r.admin, scopes: ['write:payroll', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null });
async function stranded(month: number): Promise<string> {
  const id = await r.calculatedRun(month);
  await r.pool.query(
    "UPDATE payroll_run_headers SET status='approved', approved_by=$2, approved_at=clock_timestamp(), lines_confirmed_at=clock_timestamp(), approval_grandfathered_at=clock_timestamp() WHERE id=$1",
    [id, r.admin]);
  return id;
}
/** What the caller reads, from the real registry: a returned tool error's text, or its answer for a THROW (after its savepoint). */
const call = async (run: string, dry_run = false): Promise<{ ok: boolean; text: string }> => {
  const o = await registry.call('post_payroll_journal', { run_id: run, dry_run, idempotency_key: crypto.randomUUID() }, ctx() as never) as ToolOut;
  return { ok: o.isError !== true, text: o.content[0]!.text };
};
/** A plain read on the batch's own transaction: throws "current transaction is aborted" if the victim's was not rolled back to its savepoint. */
const txAlive = async (): Promise<boolean> => (await sql`SELECT 1 AS alive`)[0]!.alive === 1;
const journalCount = async (run: string): Promise<number> => (await r.pool.query(
  "SELECT count(*)::int n FROM payroll_run_headers h JOIN gl_journal_entries j ON j.id = h.journal_entry_id WHERE h.id = $1 AND j.source = 'auto_payroll'", [run])).rows[0].n;
const waitingOnLock = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    // The waiter is inside the numbering trigger, so its top-level query text is the INSERT, not
    // pg_advisory_xact_lock; filter on what it waits FOR: an ungranted advisory lock in this database.
    const w = await r.pool.query(
      `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = current_database()`);
    if (w.rowCount) return;
    await new Promise((x) => setTimeout(x, 50));
  }
  throw new Error('the second batch never waited on the first');
};

/** A journal made the way every writer but a payroll post makes one: no approval lock, the numbering lock held to the end of the transaction. */
async function directJournal(): Promise<void> {
  const ids = (await r.pool.query("SELECT account_code, id FROM gl_accounts WHERE company_id = $1 AND account_code IN ('5200','1110')", [r.company])).rows;
  const id = (code: string): string => ids.find((x) => x.account_code === code)!.id;
  const entry = await createJournalEntry(r.company, {
    entryDate: '2026-12-31', description: 'direct journal', source: 'auto_payroll',
    lines: [{ glAccountId: id('5200'), debit: 1, credit: 0, description: 'd' }, { glAccountId: id('1110'), debit: 0, credit: 1, description: 'c' }],
  }, r.admin);
  await postJournalEntry(r.company, entry.id, r.admin);
}

it('the deadlock victim is told to retry, its batch carries on; the run ends with exactly one journal', async () => {
  // Warm-up post: first-ever journal of the year creates the fiscal year; keep that out of the race.
  expect((await withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => call(await stranded(4)))).ok).toBe(true);
  const [r2, r3, r4] = [await stranded(6), await stranded(7), await stranded(8)];
  let aHasFirst!: () => void;
  const aFirst = new Promise<void>((x) => { aHasFirst = x; });
  // Each batch ends with a query and a dry-run call on the same transaction: the survivor trivially, the victim
  // only if the registry rolled its transaction back to the savepoint (else: "current transaction is aborted").
  const batchA = withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
    await directJournal(); aHasFirst();
    const one = { ok: true, text: 'direct journal' };
    await waitingOnLock(); // batch B holds the approval lock and r2's header, and waits for the numbering lock A holds
    const two = await call(r2);
    return { calls: [one, two], alive: await txAlive(), after: await call(r3, true) };
  });
  const batchB = withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
    await aFirst;
    const one = await call(r2);
    return { calls: [one], alive: await txAlive(), after: await call(r4, true) };
  });
  const batches = await Promise.all([batchA, batchB]);
  const outcomes = batches.flatMap((b) => b.calls);
  for (const b of batches) {
    expect(b.alive).toBe(true);
    expect(b.after.ok).toBe(true);
  }

  const refused = outcomes.filter((o) => !o.ok);
  expect(refused).toHaveLength(1);
  expect(refused[0]!.text).not.toBe(GENERIC_FAILURE);
  expect(refused[0]!.text).not.toMatch(/40P01|database error/);
  expect(refused[0]!.text).toMatch(/\(deadlock\)/);
  expect(refused[0]!.text).toMatch(/nothing was written/);
  expect(refused[0]!.text).toMatch(/retry/);

  // The victim's retry, on its own (whichever batch lost, r2 ends with one journal).
  if ((await journalCount(r2)) === 0) {
    const again = await withAlsTransaction({ companyId: r.company, userId: r.admin }, () => call(r2));
    expect(again.ok).toBe(true);
  }
  expect(await journalCount(r2)).toBe(1);
}, 40000);

it('two batches that both post serialise on the company approval lock: no deadlock, the second is told the run already posted', async () => {
  const [p1, p2] = [await stranded(9), await stranded(10)];
  let aHasFirst!: () => void;
  const aFirst = new Promise<void>((x) => { aHasFirst = x; });
  const batchA = withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
    const one = await call(p1); aHasFirst();
    await waitingOnLock(); // batch B queues on the approval lock A holds to the end of its transaction
    return [one, await call(p2)];
  });
  const batchB = withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
    await aFirst;
    return [await call(p2)];
  });
  const [a, b] = await Promise.all([batchA, batchB]);
  expect(a.every((o) => o.ok)).toBe(true);
  expect(b[0]!.ok).toBe(false);
  expect(b[0]!.text).toMatch(/already posted journal/);
  expect(b[0]!.text).not.toMatch(/deadlock/);
  expect(await journalCount(p1)).toBe(1);
  expect(await journalCount(p2)).toBe(1);
}, 40000);
