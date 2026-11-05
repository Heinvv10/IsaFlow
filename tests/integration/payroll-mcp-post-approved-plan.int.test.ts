/**
 * post_payroll_journal against a run a person really approved (R-035, not grandfathered): the live call and its
 * dry run both post only the plan whose hash the approval stored, and both refuse once the run no longer hashes to
 * it. The state is the recovery case: approved, no journal linked. The approval's own journal is unlinked from the
 * header (its entry stays in the ledger of this disposable fixture), so the MCP tool is the poster. Every call goes
 * through the REAL registry in a request transaction. Disposable fixture DB only.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { McpRegistry } from '@/lib/mcp/registry';
import { postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import { PLAN_CHANGED_SINCE_APPROVAL } from '@/modules/accounting/services/payroll/payrollApprovedPlan';
import { rig } from './brkr.helpers';

type ToolOut = { isError?: boolean; content: Array<{ text: string }> };
let r: Awaited<ReturnType<typeof rig>>;
const registry = new McpRegistry();
registry.register(postPayrollJournalTool);

beforeAll(async () => { r = await rig('postapproved'); await r.setup(); await r.employee(20000); });
afterAll(async () => { await r.teardown(); });

const ctx = () => ({ companyId: r.company, userId: r.admin, scopes: ['write:payroll', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null });
const call = (run: string, dry_run: boolean) => withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
  const o = await registry.call('post_payroll_journal', { run_id: run, dry_run, idempotency_key: crypto.randomUUID() }, ctx() as never) as ToolOut;
  return { ok: o.isError !== true, text: o.content[0]!.text };
});

/** A run approved through the real gate (stores approved_plan_hash), its journal link then removed. */
async function approvedUnlinked(month: number): Promise<string> {
  const run = await r.calculatedRun(month);
  expect((await r.api.approve(run)).statusCode).toBe(200);
  const h = await r.pool.query('SELECT approved_plan_hash, approval_grandfathered_at FROM payroll_run_headers WHERE id = $1', [run]);
  expect(h.rows[0].approved_plan_hash).toBeTruthy();
  expect(h.rows[0].approval_grandfathered_at).toBeNull();
  await r.pool.query('UPDATE payroll_run_headers SET journal_entry_id = NULL WHERE id = $1', [run]);
  return run;
}
const linked = async (run: string) => (await r.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0].journal_entry_id as string | null;

it('an approved run whose plan still hashes to the approved hash previews and then posts', async () => {
  const run = await approvedUnlinked(1);
  expect((await call(run, true)).ok).toBe(true);
  expect(await linked(run)).toBeNull(); // the preview wrote nothing
  const live = await call(run, false);
  expect(live.ok).toBe(true);
  expect(await linked(run)).toBe(JSON.parse(live.text).journal_entry_id);
}, 40000);

it('once the run no longer hashes to the approved plan, the preview AND the live call refuse and post nothing', async () => {
  const run = await approvedUnlinked(2);
  // Another approval revision: what a reopen and re-approval, or a recalculation, leaves behind.
  await r.pool.query('UPDATE payroll_run_headers SET approval_revision = gen_random_uuid() WHERE id = $1', [run]);
  for (const dry of [true, false]) {
    const out = await call(run, dry);
    expect(out.ok).toBe(false);
    expect(out.text).toContain(PLAN_CHANGED_SINCE_APPROVAL);
  }
  expect(await linked(run)).toBeNull();
}, 40000);
