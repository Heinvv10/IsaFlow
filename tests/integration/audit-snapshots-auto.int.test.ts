/**
 * Forensic-controls step 4 — automatic snapshots. Closing or locking a fiscal
 * period, closing a year (both routes) and locking a VAT period take a sealed
 * snapshot at that cutoff AFTER the lock commits, as the person who locked;
 * an MCP close does too (channel token). A bulk close takes ONE. When the
 * snapshot cannot be taken the lock still stands and a failed attempt is
 * recorded with the reason.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fiscalPeriodsAction from '../../pages/api/accounting/fiscal-periods-action';
import vatPeriodLocks from '../../pages/api/accounting/vat-period-locks';
import yearEnd from '../../pages/api/accounting/year-end';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantFiscalYear, plantJournal, plantLedger, waitForSnapshots } from './audit-snapshots.helpers';
import { mcpRun } from './audit-snapshots-mcp.helpers';
import { closeFiscalPeriodTool } from '../../src/lib/mcp/tools/writeFiscalPeriods';
import { als, type RequestContext } from '../../src/lib/als';
import { withSavepoint } from '../../src/lib/neon';
import { closePeriod } from '../../src/modules/accounting/services/gl/fiscalPeriodService';
import { unrecordedLocks } from '../../src/modules/accounting/services/audit/snapshotRead';
import { takeSnapshot } from '../../src/modules/accounting/services/audit/snapshotService';
import { runAuditTx } from '../../src/modules/accounting/services/audit/auditTx';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', m = '';
const KEY = 'a'.repeat(48);

beforeAll(async () => {
  [o, m] = await members(pool, tokens, 2);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = KEY;
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'auto-test';
});
afterEach(() => { process.env.AUDIT_SNAPSHOT_SIGNING_KEY = KEY; });
afterAll(() => cleanupAudit(pool, companies, [o, m]));

async function company() {
  const c = await newCompany(pool, [[o, 'owner'], [m, 'manager']], companies);
  await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [c]);
  const l = await plantLedger(pool, c);
  // Periods first: the journal trigger stamps fiscal_period_id from them (the MCP close's readiness check reads it).
  const periods = await plantFiscalYear(pool, c, 2026, '2026-01-01');
  await plantJournal(pool, c, { date: '2026-01-15', amount: 100, debit: l.bank, credit: l.sales, by: o });
  return { c, l, periods };
}
const action = (user: string, c: string, body: Record<string, unknown>) =>
  callRoute(fiscalPeriodsAction, tokens[user]!, c, 'POST', body, '/api/accounting/fiscal-periods-action');

describe('automatic snapshots', { timeout: 120_000 }, () => {
  it('a period close takes a sealed snapshot at the period end, as the closer', async () => {
    const { c, periods } = await company();
    const res = await action(o, c, { action: 'close', id: periods[0] });
    expect(res.state.statusCode).toBe(200);
    const [s] = await waitForSnapshots(pool, c, 1);
    expect(s).toMatchObject({ trigger: 'period_close', status: 'sealed', cutoff: '2026-01-31', taken_by: o, channel: 'session' });
    const lock = await action(o, c, { action: 'lock', id: periods[0] });
    expect(lock.state.statusCode).toBe(200);
    // Nothing moved between the close and the lock: the lock records 'unchanged', pointing at the close's snapshot.
    const both = await waitForSnapshots(pool, c, 2);
    expect(both.map((x) => [x.cutoff, x.status])).toEqual([['2026-01-31', 'sealed'], ['2026-01-31', 'unchanged']]);
    const { rows: [u] } = await pool.query('SELECT same_as_snapshot_id::text AS s FROM audit_snapshots WHERE id = $1', [both[1]!.id]);
    expect(u.s).toBe(s!.id);
  });

  it('a bulk close takes one snapshot at the latest end date; close_year one more', async () => {
    const { c, periods } = await company();
    expect((await action(o, c, { action: 'bulk_close', ids: periods.slice(0, 3) })).state.statusCode).toBe(200);
    expect(await waitForSnapshots(pool, c, 1)).toEqual([expect.objectContaining({ cutoff: '2026-03-31', trigger: 'period_close' })]);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await waitForSnapshots(pool, c, 2, 0)).length).toBe(1);
    expect((await action(o, c, { action: 'close_year', fiscalYear: 2026 })).state.statusCode).toBe(200);
    expect((await waitForSnapshots(pool, c, 2))[1]).toMatchObject({ trigger: 'year_close', cutoff: '2026-12-31', status: 'sealed' });
  });

  it('the year-end close takes a year_close snapshot', async () => {
    const { c, periods } = await company();
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_system_account,account_subtype)
       VALUES($1,'3100','Retained earnings','equity','credit',true,'retained_earnings')`, [c]);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = ANY($1)", [periods]);
    const res = await callRoute(yearEnd, tokens[o]!, c, 'POST', { action: 'close', yearLabel: '2026' }, '/api/accounting/year-end');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await waitForSnapshots(pool, c, 1)).toEqual([expect.objectContaining({ trigger: 'year_close', cutoff: '2026-12-31', status: 'sealed' })]);
  });

  it('a VAT lock takes a vat_lock snapshot, here by a manager', async () => {
    const { c } = await company();
    const res = await callRoute(vatPeriodLocks, tokens[m]!, c, 'POST',
      { action: 'lock', periodStart: '2026-01-01', periodEnd: '2026-02-28' }, '/api/accounting/vat-period-locks');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await waitForSnapshots(pool, c, 1)).toEqual([expect.objectContaining({
      trigger: 'vat_lock', cutoff: '2026-02-28', status: 'sealed', taken_by: m })]);
  });

  it('an MCP period close takes one too, recorded as a token', async () => {
    const { c, periods } = await company();
    const out = await mcpRun(pool, [closeFiscalPeriodTool], o, c, 'owner', 'close_fiscal_period',
      { fiscal_period_id: periods[0] }, ['write:journals', 'write:post']);
    expect(out.isError, out.content[0]?.text).toBeFalsy();
    expect(await waitForSnapshots(pool, c, 1)).toEqual([expect.objectContaining({ trigger: 'period_close', channel: 'token' })]);
  });

  it('never blocks the lock: without a key the period closes and a failed attempt says why', async () => {
    const { c, periods } = await company();
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = '';
    const res = await action(o, c, { action: 'close', id: periods[0] });
    expect(res.state.statusCode).toBe(200);
    const { rows: [p] } = await pool.query('SELECT status FROM fiscal_periods WHERE id = $1', [periods[0]]);
    expect(p.status).toBe('closed');
    const [s] = await waitForSnapshots(pool, c, 1);
    expect(s).toMatchObject({ status: 'failed', trigger: 'period_close', cutoff: '2026-01-31' });
    expect(String(s!.failure_reason)).toMatch(/^signing_key_missing/);
  });

  it('a close inside a savepoint that rolled back takes nothing, though the request committed', async () => {
    const { c, periods } = await company();
    const client = await pool.connect();
    const claims = { sub: o, session_id: crypto.randomUUID() };
    const ctx = { client, userId: o, companyId: c, claims, afterCommit: [] } as unknown as RequestContext;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
      await als.run(ctx, async () => {
        await withSavepoint('undone_close', async () => { await closePeriod(c, periods[0]!, o); throw new Error('later step failed'); })
          .catch(() => undefined);
      });
      ctx.finished = true;
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(ctx.afterCommit).toHaveLength(1);
    // Run the queued work itself and wait for it (drainAfterCommit detaches it; a snapshot takes seconds under load).
    await ctx.afterCommit![0]!.fn();
    expect(await waitForSnapshots(pool, c, 1, 0)).toEqual([]);
    const { rows: [p] } = await pool.query('SELECT status FROM fiscal_periods WHERE id = $1', [periods[0]]);
    expect(p.status).toBe('open');
  });

  it('a close whose automatic snapshot was lost is listed as unrecorded; one that was snapshotted is not', async () => {
    const { c, periods } = await company();
    const p = { userId: o, companyId: c, claims: { sub: o, session_id: crypto.randomUUID() } };
    await takeSnapshot(p, { cutoff: '2025-12-31', trigger: 'manual' });
    // A close in a context that runs no after-commit work (a script) queues nothing: the snapshot is lost.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(p.claims)]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
      await als.run({ client, userId: o, companyId: c, claims: p.claims } as unknown as RequestContext, () => closePeriod(c, periods[0]!, o));
      await client.query('COMMIT');
    } finally { client.release(); }
    const listed = () => runAuditTx(p, 'READ COMMITTED', () => unrecordedLocks(c));
    expect(await listed()).toEqual([expect.objectContaining({ trigger: 'period_close', cutoff: '2026-01-31' })]);
    // Closing the next period through the route snapshots at 28 Feb, which also covers January's books.
    expect((await action(o, c, { action: 'close', id: periods[1] })).state.statusCode).toBe(200);
    await waitForSnapshots(pool, c, 2);
    expect(await listed()).toEqual([]);
  });

  it('closing and reopening over and over stores one snapshot, then references; a posting in between stores a new one', async () => {
    const { c, l, periods } = await company();
    for (let i = 0; i < 3; i++) {
      expect((await action(o, c, { action: 'close', id: periods[0] })).state.statusCode).toBe(200);
      await waitForSnapshots(pool, c, i + 1);
      expect((await action(o, c, { action: 'reopen', id: periods[0] })).state.statusCode).toBe(200);
    }
    await plantJournal(pool, c, { date: '2026-01-20', amount: 5, debit: l.bank, credit: l.sales, by: o });
    expect((await action(o, c, { action: 'close', id: periods[0] })).state.statusCode).toBe(200);
    const all = await waitForSnapshots(pool, c, 4);
    expect(all.map((x) => x.status)).toEqual(['sealed', 'unchanged', 'unchanged', 'sealed']);
  });

  it('a later close undone in a savepoint does not cost the earlier, standing close its snapshot', async () => {
    const { c, periods } = await company();
    const client = await pool.connect();
    const claims = { sub: o, session_id: crypto.randomUUID() };
    const ctx = { client, userId: o, companyId: c, claims, afterCommit: [] } as unknown as RequestContext;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
      await als.run(ctx, async () => {
        await closePeriod(c, periods[0]!, o);
        await withSavepoint('undone_second', async () => { await closePeriod(c, periods[1]!, o); throw new Error('undo'); })
          .catch(() => undefined);
      });
      ctx.finished = true;
      await client.query('COMMIT');
    } finally { client.release(); }
    await ctx.afterCommit![0]!.fn();
    expect(await waitForSnapshots(pool, c, 1, 0)).toEqual([expect.objectContaining({ cutoff: '2026-01-31', status: 'sealed' })]);
  });

  it('a refused close takes nothing', async () => {
    const { c, periods } = await company();
    const res = await action(o, c, { action: 'close', id: periods[2] });
    expect(res.state.statusCode).toBeGreaterThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await waitForSnapshots(pool, c, 1, 0)).toEqual([]);
  });
});
