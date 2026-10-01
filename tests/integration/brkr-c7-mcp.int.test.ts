/**
 * BRK-596 round 4 — CLAIM 7 "MCP". approve_pay_run / calculate_pay_run through the real registry
 * (scope checks, company assert, idempotency, savepoint, audit) inside one transaction per call,
 * as the bearer pipeline runs them. Asserts the claim; red = break.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let salaryRow = '';
const other = crypto.randomUUID();
const ALL = ['read:payroll', 'write:payroll', 'write:post', 'read:accounting', 'write:accounting'];

const fingerprint = async () => (await r.pool.query(
  `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h FROM (
     SELECT row_to_json(h)::text AS x FROM payroll_run_headers h WHERE company_id = ANY($1)
     UNION ALL SELECT row_to_json(l)::text FROM payroll_run_lines l WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ANY($1))
     UNION ALL SELECT row_to_json(e)::text FROM gl_journal_entries e WHERE company_id = ANY($1)
     UNION ALL SELECT row_to_json(l)::text FROM gl_journal_lines l WHERE company_id = ANY($1)) s`, [[r.company, other]])).rows[0]!.h as string;

let key = 0;
async function tool(name: string, args: Record<string, unknown>, o: { scopes?: string[]; company?: string } = {}) {
  const ctx = { userId: r.admin, companyId: o.company ?? r.company, scopes: o.scopes ?? ALL, tokenJti: null, oauthAppId: null };
  key += 1;
  const before = await fingerprint();
  let res: { isError?: boolean; content: Array<{ text: string }> };
  try {
    res = await withAlsTransaction({ userId: ctx.userId, companyId: ctx.companyId },
      () => mcpRegistry.call(name, { idempotency_key: `brk-${key}-${crypto.randomUUID()}`, ...args }, ctx as never)) as never;
  } catch (err) {
    res = { isError: true, content: [{ text: `THROWN: ${(err as Error).message}` }] };
  }
  const text = res.content?.[0]?.text ?? '';
  let json: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = null; }
  return { isError: res.isError === true, text: text.slice(0, 260), json, wroteNothing: (await fingerprint()) === before };
}

beforeAll(async () => {
  r = await rig('c7'); await r.setup(); ({ salaryRow } = await r.employee(20000));
  await r.pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'BRK596 c7 other tenant']);
});
afterAll(async () => { await r.teardown([other]); });

describe('CLAIM 7 — MCP approve_pay_run', () => {
  it('C7: scope, hash, dry-run parity, company binding', async () => {
    const out: Record<string, unknown> = {};
    const id = await r.calculatedRun(1);

    const noPost = await tool('approve_pay_run', { run_id: id, expected_plan_hash: 'x' }, { scopes: ['read:payroll', 'write:payroll'] });
    out.noPostScope = noPost; expect.soft(noPost.isError && noPost.wroteNothing, 'no write:post').toBe(true);
    const noPostDry = await tool('approve_pay_run', { run_id: id, dry_run: true }, { scopes: ['read:payroll', 'write:payroll'] });
    out.noPostScopeDryRun = noPostDry; expect.soft(noPostDry.wroteNothing).toBe(true);
    const noPayroll = await tool('approve_pay_run', { run_id: id, expected_plan_hash: 'x' }, { scopes: ['write:post'] });
    out.noPayrollScope = noPayroll; expect.soft(noPayroll.isError && noPayroll.wroteNothing, 'no write:payroll').toBe(true);

    const noHash = await tool('approve_pay_run', { run_id: id });
    out.liveNoHash = noHash; expect.soft(noHash.isError && noHash.wroteNothing, 'live without hash').toBe(true);
    for (const bad of [['x'], 0, null, '', { a: 1 }, true]) {
      const x = await tool('approve_pay_run', { run_id: id, expected_plan_hash: bad });
      expect.soft(x.isError && x.wroteNothing, `bad hash ${JSON.stringify(bad)}`).toBe(true);
    }
    const wrong = await tool('approve_pay_run', { run_id: id, expected_plan_hash: 'f'.repeat(64) });
    out.liveWrongHash = wrong; expect.soft(wrong.isError && wrong.wroteNothing, 'wrong hash').toBe(true);

    const xTenant = await tool('approve_pay_run', { run_id: id, dry_run: true }, { company: other });
    out.otherCompanyCtxDry = xTenant; expect.soft(xTenant.isError && xTenant.wroteNothing, 'other tenant dry').toBe(true);
    const xTenantLive = await tool('approve_pay_run', { run_id: id, expected_plan_hash: 'f'.repeat(64) }, { company: other });
    out.otherCompanyCtxLive = xTenantLive; expect.soft(xTenantLive.isError && xTenantLive.wroteNothing, 'other tenant live').toBe(true);
    const assertMismatch = await tool('approve_pay_run', { run_id: id, dry_run: true, company_id: other });
    out.companyAssertMismatch = assertMismatch; expect.soft(assertMismatch.isError && assertMismatch.wroteNothing, 'company assert').toBe(true);

    // dry run → the HTTP preview's hash; a recalculation in between is refused; then live
    const dry = await tool('approve_pay_run', { run_id: id, dry_run: true });
    out.dryRun = dry; expect.soft(dry.wroteNothing && !dry.isError, 'dry run writes nothing').toBe(true);
    const httpHash = (await r.api.preview(id)).body.data!.planHash;
    expect.soft(dry.json?.plan_hash).toBe(httpHash);
    await r.setSalary(salaryRow, 22000);
    const recalc = await tool('calculate_pay_run', { run_id: id });
    out.calculate = { isError: recalc.isError, gross: recalc.json?.total_gross };
    const stale = await tool('approve_pay_run', { run_id: id, expected_plan_hash: dry.json?.plan_hash });
    out.liveStaleHashAfterRecalc = stale; expect.soft(stale.isError && stale.wroteNothing, 'stale hash').toBe(true);
    const dry2 = await tool('approve_pay_run', { run_id: id, dry_run: true });
    const live = await tool('approve_pay_run', { run_id: id, expected_plan_hash: dry2.json?.plan_hash });
    out.live = live; expect.soft(live.isError).toBe(false);
    const j1 = String(live.json?.journal_entry_id);
    const stamp = (await r.pool.query('SELECT posting_agent FROM gl_journal_entries WHERE id = $1', [j1]).catch(() => ({ rows: [{}] }))).rows[0];
    out.journalStamp = stamp;

    // parity on every gate state: dry run refuses exactly when the live call refuses
    const parity: unknown[] = [];
    const both = async (state: string) => {
      const d = await tool('approve_pay_run', { run_id: id, dry_run: true });
      const l = await tool('approve_pay_run', { run_id: id, expected_plan_hash: d.json?.plan_hash ?? 'f'.repeat(64) });
      parity.push({ state, dryRefuses: d.isError, dryWroteNothing: d.wroteNothing, liveRefuses: l.isError, dry: d.text.slice(0, 120), live: l.text.slice(0, 120) });
      expect.soft(d.wroteNothing, `${state}: dry run wrote nothing`).toBe(true);
      expect.soft(d.isError, `${state}: dry/live parity`).toBe(l.isError);
      if (l.isError) expect.soft(l.wroteNothing, `${state}: refused live wrote nothing`).toBe(true);
      return l;
    };
    await both('approved, journal live');
    await r.api.reopen(id);
    await both('reopened, journal live, figures equal (re-lock)');
    await r.api.reopen(id);
    await r.setSalary(salaryRow, 23000); await r.api.calculate(id);
    await both('reopened, recalculated, journal live');
    await r.api.reverse(j1);
    const replaced = await both('reopened, journal reversed (replace)');
    await r.api.reopen(id);
    await r.pool.query(`UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_code = '2140'`, [r.company]);
    await both('reopened, journal live, target account deactivated (re-lock path)');
    await r.pool.query(`UPDATE gl_accounts SET is_active = true WHERE company_id = $1 AND account_code = '2140'`, [r.company]);
    const h = await r.header(id);
    if (h.status === 'approved') await r.api.reopen(id);
    const j2 = String(replaced.json?.journal_entry_id);
    await r.api.reverse(j2); await r.api.reverse(await r.contraOf(j2));
    await both('reopened, journal reversed and re-reversed');
    out.parity = parity;
    r.evidence('C7 MCP approve_pay_run', out);
    await r.setSalary(salaryRow, 20000);
  }, 60000);

  // Round 5: the generic reversal is payroll-aware in the SERVICE, so the MCP tool is covered — and
  // its dry run asks the same question read-only, so it refuses what the live call refuses.
  it('reverse_journal_entry: a pay run\'s journal — dry run and live call refuse the same things, writing nothing', async () => {
    const scopes = [...ALL, 'write:journals', 'read:journals'];
    const id = await r.calculatedRun(2);
    const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);

    for (const dry_run of [true, false]) {
      const x = await tool('reverse_journal_entry', { journal_entry_id: j1, dry_run }, { scopes });
      expect.soft(x.isError && x.wroteNothing, `approved run, dry_run ${dry_run}`).toBe(true);
      expect.soft(x.text).toMatch(/Reopen the pay run first/);
    }
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    const ok = await tool('reverse_journal_entry', { journal_entry_id: j1 }, { scopes });
    expect(ok.isError).toBe(false);
    const contra = await r.contraOf(j1);
    for (const dry_run of [true, false]) {
      const x = await tool('reverse_journal_entry', { journal_entry_id: contra, dry_run }, { scopes });
      expect.soft(x.isError && x.wroteNothing, `reversal of the reversal, dry_run ${dry_run}`).toBe(true);
      expect.soft(x.text).toMatch(/would put the run's amounts back in the ledger/); // `text` is cut at 260 chars
    }
  }, 60000);
});
