/**
 * Two MCP JSON-RPC batches (one request transaction each) posting two runs in opposite order. After a batch
 * creates a journal it holds the company-wide journal-numbering advisory lock; locking the next run's header then
 * inverts the single call's order (header, then numbering), so Postgres kills one batch with 40P01. That victim
 * is answered as a retryable refusal naming the cause (not GENERIC_FAILURE), and once retried on its own every run
 * ends with exactly one journal. Disposable fixture DB only.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import { GENERIC_FAILURE, thrownToolErrorText } from '@/lib/mcp/thrownToolErrorText';
import { rig } from './brkr.helpers';

type ToolOut = { isError?: boolean; content: Array<{ text: string }> };
let r: Awaited<ReturnType<typeof rig>>;
beforeAll(async () => { r = await rig('batchdl'); await r.setup(); await r.employee(20000); });
afterAll(async () => { await r.teardown(); });

const ctx = () => ({ companyId: r.company, userId: r.admin, scopes: ['write:payroll', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null });
async function stranded(month: number): Promise<string> {
  const id = await r.calculatedRun(month);
  await r.pool.query(
    "UPDATE payroll_run_headers SET status='approved', approved_by=$2, approved_at=clock_timestamp(), lines_confirmed_at=clock_timestamp() WHERE id=$1",
    [id, r.admin]);
  return id;
}
/** What the caller reads: a returned tool error's text, or what the registry answers for a THROW. */
const call = async (run: string): Promise<{ ok: boolean; text: string }> => {
  try {
    const o = await postPayrollJournalTool.handler({ run_id: run, idempotency_key: crypto.randomUUID() }, ctx() as never) as ToolOut;
    return { ok: o.isError !== true, text: o.content[0]!.text };
  } catch (e) { return { ok: false, text: thrownToolErrorText('post_payroll_journal', e) }; }
};
const journalCount = async (run: string): Promise<number> => (await r.pool.query(
  "SELECT count(*)::int n FROM payroll_run_headers h JOIN gl_journal_entries j ON j.id = h.journal_entry_id WHERE h.id = $1 AND j.source = 'auto_payroll'", [run])).rows[0].n;
const waitingOnLock = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    const w = await r.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (w.rowCount) return;
    await new Promise((x) => setTimeout(x, 50));
  }
  throw new Error('the second batch never waited on the first');
};

it('the deadlock victim is told to retry; each run ends with exactly one journal', async () => {
  // Warm-up post: first-ever journal of the year creates the fiscal year; keep that out of the race.
  expect((await withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => call(await stranded(4)))).ok).toBe(true);
  const r1 = await stranded(5);
  const r2 = await stranded(6);
  let aHasFirst!: () => void;
  const aFirst = new Promise<void>((x) => { aHasFirst = x; });
  const batchA = withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
    const one = await call(r1); aHasFirst();
    await waitingOnLock(); // batch B holds r2's header and waits for the numbering lock A holds
    return [one, await call(r2)];
  });
  const batchB = withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
    await aFirst;
    return [await call(r2)];
  });
  const outcomes = (await Promise.all([batchA, batchB])).flat();

  const refused = outcomes.filter((o) => !o.ok);
  expect(refused).toHaveLength(1);
  expect(refused[0]!.text).not.toBe(GENERIC_FAILURE);
  expect(refused[0]!.text).not.toMatch(/40P01|database error/);
  expect(refused[0]!.text).toMatch(/opposite orders/);
  expect(refused[0]!.text).toMatch(/retry/);

  for (const run of [r1, r2]) { // the victim's retry, on its own
    if ((await journalCount(run)) === 0) {
      const again = await withAlsTransaction({ companyId: r.company, userId: r.admin }, () => call(run));
      expect(again.ok).toBe(true);
    }
    expect(await journalCount(run)).toBe(1);
  }
}, 40000);
