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
 * that is not closed. Reopen is not gated. Lock and year-end re-gating, the
 * could-not-compute block, tenancy and roles: period-close-readiness-lock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members } from './entity-changes.helpers';
import { cleanupAudit } from './audit-snapshots.helpers';
import { mcpRun } from './audit-snapshots-mcp.helpers';
import { closeFiscalPeriodTool } from '../../src/lib/mcp/tools/writeFiscalPeriods';
import { details, gateFixture } from './helpers/periodCloseGateFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const fx = gateFixture(pool, companies, tokens);

beforeAll(async () => { [fx.owner] = await members(pool, tokens, 1); });
afterAll(() => cleanupAudit(pool, companies, [fx.owner]));

// The reason's wording is the check's own; only its count is pinned. The fix link is the check's (bank reconciliation, since #1442).
const BANK_BLOCKER = {
  key: 'bank_reconciled', label: 'Bank reconciled',
  reason: expect.stringMatching(/^1 unreconciled bank transaction/), fixHref: '/accounting/bank-reconciliation',
};

describe('period close readiness gate', () => {
  it('Close: 409 with the failing check, period stays open; closes once reconciled', async () => {
    const b = await fx.books();
    const line = await fx.unreconciledLine(b, '2026-01-20');
    const refused = await fx.action(b.c, { action: 'close', id: b.periods[0], confirm: true });
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    expect(details(refused.state.body)).toEqual({
      code: 'PERIOD_CLOSE_NOT_READY',
      periods: [{ periodId: b.periods[0], periodName: 'P1 2026', blockers: [BANK_BLOCKER] }],
    });
    expect((await fx.statuses(b.c))[0]).toBe('open');

    await fx.reconcile(line);
    const closed = await fx.action(b.c, { action: 'close', id: b.periods[0], confirm: true });
    expect(closed.state.statusCode, JSON.stringify(closed.state.body)).toBe(200);
    expect((await fx.statuses(b.c))[0]).toBe('closed');
  });

  it('a warning does not block: no VAT return covers the period, and it closes', async () => {
    const b = await fx.books();
    const res = await fx.action(b.c, { action: 'close', id: b.periods[0], confirm: true });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('Bulk Close: the blocked period is refused with its checks, the ready one closes', async () => {
    const b = await fx.books();
    const line = await fx.unreconciledLine(b, '2026-02-10');
    const res = await fx.action(b.c, { action: 'bulk_close', ids: [b.periods[1], b.periods[0]], confirm: true });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const data = (res.state.body as { data: { okCount: number; results: Array<Record<string, unknown>> } }).data;
    expect(data.okCount).toBe(1);
    // Click order is kept in the answer; the server closed them in period order (January first).
    expect(data.results[0]).toMatchObject({
      id: b.periods[1], ok: false, code: 'PERIOD_CLOSE_NOT_READY',
      periods: [{ periodId: b.periods[1], blockers: [BANK_BLOCKER] }],
    });
    expect(data.results[1]).toEqual({ id: b.periods[0], ok: true });
    expect((await fx.statuses(b.c)).slice(0, 2)).toEqual(['closed', 'open']);

    await fx.reconcile(line);
    const again = await fx.action(b.c, { action: 'bulk_close', ids: [b.periods[1]], confirm: true });
    expect((again.state.body as { data: { okCount: number } }).data.okCount).toBe(1);
    expect((await fx.statuses(b.c)).slice(0, 2)).toEqual(['closed', 'closed']);
  });

  it('T4 Bulk Close: a blocked earlier period refuses, and the later one that depends on it says prior periods are open', async () => {
    const b = await fx.books();
    await fx.unreconciledLine(b, '2026-01-05');
    const res = await fx.action(b.c, { action: 'bulk_close', ids: [b.periods[0], b.periods[1]], confirm: true });
    const rows = (res.state.body as { data: { results: Array<Record<string, unknown>> } }).data.results;
    expect(rows[0]).toMatchObject({ id: b.periods[0], ok: false, code: 'PERIOD_CLOSE_NOT_READY' });
    expect(rows[1]).toEqual({ id: b.periods[1], ok: false,
      error: 'P2 2026 cannot be closed: prior periods are still open (P1 2026). Close them first.' });
    expect((await fx.statuses(b.c)).slice(0, 2)).toEqual(['open', 'open']);
  });

  it('Close Year: all or nothing — one blocked period refuses the year, named, and nothing closes', async () => {
    const b = await fx.books();
    const lines = [await fx.unreconciledLine(b, '2026-03-05'), await fx.unreconciledLine(b, '2026-11-30')];
    const refused = await fx.action(b.c, { action: 'close_year', fiscalYear: 2026, confirm: true });
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    const d = details(refused.state.body);
    expect(d).toMatchObject({ code: 'PERIOD_CLOSE_NOT_READY', fiscalYear: 2026 });
    expect(d.periods.map((p) => [p.periodId, p.blockers.map((x) => x.key)])).toEqual([
      [b.periods[2], ['bank_reconciled']], [b.periods[10], ['bank_reconciled']],
    ]);
    expect(new Set(await fx.statuses(b.c))).toEqual(new Set(['open']));

    for (const l of lines) await fx.reconcile(l);
    const closed = await fx.action(b.c, { action: 'close_year', fiscalYear: 2026, confirm: true });
    expect(closed.state.statusCode, JSON.stringify(closed.state.body)).toBe(200);
    expect(new Set(await fx.statuses(b.c))).toEqual(new Set(['closed']));

    // T5: every period settled is a plain refusal, not a 409 and not a 200.
    const again = await fx.action(b.c, { action: 'close_year', fiscalYear: 2026, confirm: true });
    expect(again.state.statusCode).toBe(400);
    expect(JSON.stringify(again.state.body)).toContain('Fiscal year 2026 is already closed');
  });

  it('MCP close_fiscal_period refuses with the check, then closes once reconciled', async () => {
    const b = await fx.books();
    const line = await fx.unreconciledLine(b, '2026-01-31');
    const run = () => mcpRun(pool, [closeFiscalPeriodTool], fx.owner, b.c, 'owner', 'close_fiscal_period',
      { fiscal_period_id: b.periods[0] }, ['write:journals', 'write:post']);
    const refused = await run();
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/bank_reconciled: 1 unreconciled bank transaction/);
    expect((await fx.statuses(b.c))[0]).toBe('open');

    await fx.reconcile(line);
    const closed = await run();
    expect(closed.isError, closed.content[0]?.text).toBeFalsy();
    expect((await fx.statuses(b.c))[0]).toBe('closed');
  });

  it('year-end close refuses a period that is not closed (status closing), naming it; locks once all are closed', async () => {
    const b = await fx.books();
    await fx.retainedEarnings(b.c);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = ANY($1)", [b.periods]);
    await pool.query("UPDATE fiscal_periods SET status = 'closing' WHERE id = $1", [b.periods[11]]);

    const refused = await fx.yearEndClose(b.c);
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(400);
    expect(JSON.stringify(refused.state.body)).toContain('1 period is not closed yet (P12 2026)');
    expect(await fx.statuses(b.c)).not.toContain('locked');

    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = $1", [b.periods[11]]);
    const closed = await fx.yearEndClose(b.c);
    expect(closed.state.statusCode, JSON.stringify(closed.state.body)).toBe(200);
    expect(new Set(await fx.statuses(b.c))).toEqual(new Set(['locked']));
  });

  it('Reopen is not gated: a closed period with an unreconciled line reopens', async () => {
    const b = await fx.books();
    expect((await fx.action(b.c, { action: 'close', id: b.periods[0], confirm: true })).state.statusCode).toBe(200);
    await fx.unreconciledLine(b, '2026-01-10');
    const res = await fx.action(b.c, { action: 'reopen', id: b.periods[0] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await fx.statuses(b.c))[0]).toBe('open');
  });
});
