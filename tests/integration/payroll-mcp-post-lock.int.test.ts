/**
 * post_payroll_journal against a run another request is posting: the MCP post
 * took no lock on the run's header, the idempotency key serialises only calls
 * that share it, and the final UPDATE did not check the run was still without
 * a journal. Two posts under different keys, or a post beside an approval, each
 * saw an approved run with no journal and each posted one, leaving the first
 * orphaned in the ledger.
 *
 * Made deterministic: the first request is parked at the start of
 * createJournalEntry (it holds whatever it locked and has written nothing); the
 * second is started and the first released only once the second has finished or
 * is waiting on a lock. Each call runs in a request transaction, as the MCP
 * registry's does (the header lock lasts to its end). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';

const park = vi.hoisted(() => ({ hold: null as null | Promise<void>, entered: null as null | (() => void) }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/gl/journalEntryCrudService')>();
  return {
    ...actual,
    createJournalEntry: async (...a: Parameters<typeof actual.createJournalEntry>) => {
      if (park.hold) { const hold = park.hold; park.hold = null; park.entered?.(); await hold; }
      return actual.createJournalEntry(...a);
    },
  };
});

import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import { rig } from './brkr.helpers';

type ToolOut = { isError?: boolean; content: Array<{ text: string }> };
let r: Awaited<ReturnType<typeof rig>>;

beforeAll(async () => { r = await rig('postlock'); await r.setup(); await r.employee(20000); });
afterAll(async () => { await r.teardown(); });

const ctx = () => ({ companyId: r.company, userId: r.admin, scopes: ['write:payroll', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null });
/** One MCP call in its own request transaction, as the registry runs it. */
const post = (run: string) => withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
  const out = await postPayrollJournalTool.handler({ run_id: run, idempotency_key: crypto.randomUUID() }, ctx() as never) as ToolOut;
  return { isError: out.isError === true, text: out.content[0]!.text };
});
const approveService = (run: string) => withAlsTransaction({ companyId: r.company, userId: r.admin },
  () => approvePayrollRun(r.company, run, r.admin).then((v) => ({ ok: true as const, journal: v.journalEntryId }), (e: Error) => ({ ok: false as const, message: e.message })));

/** An 'approved' run with no journal: the state a failed approve-and-post left before K-079. */
async function strandedRun(month: number): Promise<string> {
  const id = await r.calculatedRun(month);
  await r.pool.query(
    "UPDATE payroll_run_headers SET status = 'approved', approved_by = $2, approved_at = clock_timestamp(), lines_confirmed_at = clock_timestamp() WHERE id = $1",
    [id, r.admin]);
  return id;
}
const parkNext = () => {
  let release!: () => void;
  park.hold = new Promise<void>((res) => { release = res; });
  const entered = new Promise<void>((res) => { park.entered = res; });
  return { release, entered };
};
async function waitsOnRunLock(): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const w = await r.pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND (query ILIKE '%payroll_run_headers%' OR query ILIKE '%pg_advisory_xact_lock%')`);
    if (w.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('the second request neither finished nor waited on the run lock');
}
const journalsOf = async (run: string) => (await r.pool.query(
  `SELECT e.id::text AS id FROM gl_journal_entries e WHERE e.company_id = $1 AND e.source = 'auto_payroll'
      AND e.description = (SELECT 'Payroll run ' || period_year || '-' || lpad(period_month::text, 2, '0') FROM payroll_run_headers WHERE id = $2)`,
  [r.company, run])).rows.map((x) => x.id as string);
const linked = async (run: string) => (await r.pool.query('SELECT journal_entry_id::text AS j FROM payroll_run_headers WHERE id = $1', [run])).rows[0]!.j as string | null;

describe('post_payroll_journal: one journal per run, whoever gets there', () => {
  it('two posts under different keys: one posts, the other is refused, one journal', async () => {
    const run = await strandedRun(1);
    const { release, entered } = parkNext();
    const firstP = post(run);
    await entered; // past its plan, holding the run, nothing written
    const secondP = post(run);
    const state = await Promise.race([secondP.then(() => 'finished' as const), waitsOnRunLock()]);
    release();
    const [first, second] = await Promise.all([firstP, secondP]);

    const journals = await journalsOf(run);
    expect(journals).toHaveLength(1);
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/already posted journal/);
    expect(await linked(run)).toBe(journals[0]);
    expect(JSON.parse(first.text).journal_entry_id).toBe(journals[0]);
    expect(state).toBe('waiting'); // the second request queued behind the first's lock
  });

  it('a post while an approval is posting: the approval\'s journal stands, the post is refused', async () => {
    const run = await strandedRun(2);
    const { release, entered } = parkNext();
    const approveP = approveService(run);
    await entered; // approval holds the company lock and the header, journal not yet created
    const postP = post(run);
    const state = await Promise.race([postP.then(() => 'finished' as const), waitsOnRunLock()]);
    release();
    const [approved, posted] = await Promise.all([approveP, postP]);

    const journals = await journalsOf(run);
    expect(journals).toHaveLength(1);
    expect(approved).toMatchObject({ ok: true });
    expect(posted.isError).toBe(true);
    expect(posted.text).toMatch(/already posted journal/);
    expect(await linked(run)).toBe(journals[0]);
    expect(state).toBe('waiting'); // the second request queued behind the first's lock
  });

  it('an approval while a post is posting: the post\'s journal stands, the approval adds none', async () => {
    const run = await strandedRun(3);
    const { release, entered } = parkNext();
    const postP = post(run);
    await entered; // the post holds the header, journal not yet created
    const approveP = approveService(run);
    const state = await Promise.race([approveP.then(() => 'finished' as const), waitsOnRunLock()]);
    release();
    const [posted, approved] = await Promise.all([postP, approveP]);

    const journals = await journalsOf(run);
    expect(posted.isError).toBe(false);
    expect(journals).toHaveLength(1); // whatever the approval answered, the month is in the ledger once
    expect(await linked(run)).toBe(journals[0]);
    // The post won: the run carries a journal, so the approval is refused (it adds none), whatever its timing.
    expect(approved).toEqual({ ok: false, message: expect.stringMatching(/Cannot approve payroll run with status 'approved'/) });
    expect(state).toBe('waiting'); // the second request queued behind the first's lock
  });
});
