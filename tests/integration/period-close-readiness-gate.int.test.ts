/**
 * Every close path refuses when a period-close readiness check fails (Hein,
 * 2026-11-15), and closes when the checks pass. The failing check here is
 * bank_reconciled on master's definition: one posted bank line still
 * `imported` inside the period. Fixing it (the line reconciled) lets the same
 * call through.
 *
 * Paths: the app's Close, Bulk Close and Close Year (fiscal-periods-action, as
 * an owner through withAuth), MCP close_fiscal_period, and the year-end close
 * (POST /api/accounting/year-end), which locks a year and must refuse a period
 * that never went through the gated close. Reopen is not gated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fiscalPeriodsAction from '../../pages/api/accounting/fiscal-periods-action';
import yearEnd from '../../pages/api/accounting/year-end';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantFiscalYear, plantJournal, plantLedger, type Ledger } from './audit-snapshots.helpers';
import { mcpRun } from './audit-snapshots-mcp.helpers';
import { closeFiscalPeriodTool } from '../../src/lib/mcp/tools/writeFiscalPeriods';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';

beforeAll(async () => { [owner] = await members(pool, tokens, 1); });
afterAll(() => cleanupAudit(pool, companies, [owner]));

interface Books { c: string; l: Ledger; periods: string[] }

/** A company with FY2026 (Jan–Dec), one posted journal in January, and nothing else outstanding. */
async function books(): Promise<Books> {
  const c = await newCompany(pool, [[owner!, 'owner']], companies);
  await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [c]);
  const l = await plantLedger(pool, c);
  const periods = await plantFiscalYear(pool, c, 2026, '2026-01-01');
  await plantJournal(pool, c, { date: '2026-01-15', amount: 100, debit: l.bank, credit: l.sales, by: owner });
  return { c, l, periods };
}

/** One imported (unreconciled) bank line dated `date`: bank_reconciled fails for its period. */
async function unreconciledLine(b: Books, date: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,$4::DATE,-250,'gate line','imported')`, [id, b.c, b.l.bank, date]);
  return id;
}
const reconcile = (id: string) => pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [id]);

const action = (c: string, body: Record<string, unknown>) =>
  callRoute(fiscalPeriodsAction, tokens[owner]!, c, 'POST', body, '/api/accounting/fiscal-periods-action');
const statuses = async (c: string) =>
  (await pool.query('SELECT status FROM fiscal_periods WHERE company_id = $1 ORDER BY period_number', [c])).rows.map((r) => r.status as string);

type Details = { code: string; fiscalYear?: number; periods: Array<{ periodId: string; periodName: string; blockers: Array<Record<string, string>> }> };
const details = (body: unknown) => (body as { error: { details: Details } }).error.details;
// The reason's wording is the check's own (PR #1442 rewrites that check); only its count is pinned.
const BANK_BLOCKER = {
  key: 'bank_reconciled', label: 'Bank reconciled',
  reason: expect.stringMatching(/^1 unreconciled bank transaction/), fixHref: '/accounting/bank-transactions',
};

describe('period close readiness gate', () => {
  it('Close: 409 with the failing check, period stays open; closes once reconciled', async () => {
    const b = await books();
    const line = await unreconciledLine(b, '2026-01-20');
    const refused = await action(b.c, { action: 'close', id: b.periods[0], confirm: true });
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    expect(details(refused.state.body)).toEqual({
      code: 'PERIOD_CLOSE_NOT_READY',
      periods: [{ periodId: b.periods[0], periodName: 'P1 2026', blockers: [BANK_BLOCKER] }],
    });
    expect((await statuses(b.c))[0]).toBe('open');

    await reconcile(line);
    const closed = await action(b.c, { action: 'close', id: b.periods[0], confirm: true });
    expect(closed.state.statusCode, JSON.stringify(closed.state.body)).toBe(200);
    expect((await statuses(b.c))[0]).toBe('closed');
  });

  it('a warning does not block: no VAT return covers the period, and it closes', async () => {
    const b = await books();
    const res = await action(b.c, { action: 'close', id: b.periods[0], confirm: true });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('Bulk Close: the blocked period is refused with its checks, the ready one closes', async () => {
    const b = await books();
    const line = await unreconciledLine(b, '2026-02-10');
    const res = await action(b.c, { action: 'bulk_close', ids: [b.periods[0], b.periods[1]], confirm: true });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const data = (res.state.body as { data: { okCount: number; results: Array<Record<string, unknown>> } }).data;
    expect(data.okCount).toBe(1);
    expect(data.results[1]).toMatchObject({
      id: b.periods[1], ok: false, code: 'PERIOD_CLOSE_NOT_READY',
      periods: [{ periodId: b.periods[1], blockers: [BANK_BLOCKER] }],
    });
    expect((await statuses(b.c)).slice(0, 2)).toEqual(['closed', 'open']);

    await reconcile(line);
    const again = await action(b.c, { action: 'bulk_close', ids: [b.periods[1]], confirm: true });
    expect((again.state.body as { data: { okCount: number } }).data.okCount).toBe(1);
    expect((await statuses(b.c)).slice(0, 2)).toEqual(['closed', 'closed']);
  });

  it('Close Year: all or nothing — one blocked period refuses the year, named, and nothing closes', async () => {
    const b = await books();
    const lines = [await unreconciledLine(b, '2026-03-05'), await unreconciledLine(b, '2026-11-30')];
    const refused = await action(b.c, { action: 'close_year', fiscalYear: 2026, confirm: true });
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    const d = details(refused.state.body);
    expect(d).toMatchObject({ code: 'PERIOD_CLOSE_NOT_READY', fiscalYear: 2026 });
    expect(d.periods.map((p) => [p.periodId, p.blockers.map((x) => x.key)])).toEqual([
      [b.periods[2], ['bank_reconciled']], [b.periods[10], ['bank_reconciled']],
    ]);
    expect(new Set(await statuses(b.c))).toEqual(new Set(['open']));

    for (const l of lines) await reconcile(l);
    const closed = await action(b.c, { action: 'close_year', fiscalYear: 2026, confirm: true });
    expect(closed.state.statusCode, JSON.stringify(closed.state.body)).toBe(200);
    expect(new Set(await statuses(b.c))).toEqual(new Set(['closed']));
  });

  it('MCP close_fiscal_period refuses with the check, then closes once reconciled', async () => {
    const b = await books();
    const line = await unreconciledLine(b, '2026-01-31');
    const run = () => mcpRun(pool, [closeFiscalPeriodTool], owner, b.c, 'owner', 'close_fiscal_period',
      { fiscal_period_id: b.periods[0] }, ['write:journals', 'write:post']);
    const refused = await run();
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/bank_reconciled: 1 unreconciled bank transaction/);
    expect((await statuses(b.c))[0]).toBe('open');

    await reconcile(line);
    const closed = await run();
    expect(closed.isError, closed.content[0]?.text).toBeFalsy();
    expect((await statuses(b.c))[0]).toBe('closed');
  });

  it('year-end close refuses a period that is not closed (status closing), locks once all are closed', async () => {
    const b = await books();
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_system_account,account_subtype)
       VALUES($1,'3100','Retained earnings','equity','credit',true,'retained_earnings')`, [b.c]);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = ANY($1)", [b.periods]);
    await pool.query("UPDATE fiscal_periods SET status = 'closing' WHERE id = $1", [b.periods[11]]);
    const yearEndClose = () => callRoute(yearEnd, tokens[owner]!, b.c, 'POST',
      { action: 'close', yearLabel: '2026', confirm: true }, '/api/accounting/year-end');

    const refused = await yearEndClose();
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(400);
    expect(JSON.stringify(refused.state.body)).toMatch(/1 periods still open/);
    expect(await statuses(b.c)).not.toContain('locked');

    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = $1", [b.periods[11]]);
    const closed = await yearEndClose();
    expect(closed.state.statusCode, JSON.stringify(closed.state.body)).toBe(200);
    expect(new Set(await statuses(b.c))).toEqual(new Set(['locked']));
  });

  it('Reopen is not gated: a closed period with an unreconciled line reopens', async () => {
    const b = await books();
    expect((await action(b.c, { action: 'close', id: b.periods[0], confirm: true })).state.statusCode).toBe(200);
    await unreconciledLine(b, '2026-01-10');
    const res = await action(b.c, { action: 'reopen', id: b.periods[0] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await statuses(b.c))[0]).toBe('open');
  });
});
