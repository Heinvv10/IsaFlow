/**
 * The readiness gate, continued (review of PR #1451, 2026-11-15):
 *   B1  Lock, Bulk Lock and the year-end close judge the periods they lock: a
 *       period closed before the gate, or one a bank line landed in after its
 *       close, is refused before it is locked for good (dry run included).
 *   T1  "Could not compute" blocks for real: open AR invoices and no AR control
 *       account make ar_ties uncomputed, and the close is refused.
 *   T3  Another company's period id is not found, and stays untouched.
 *   B5  MCP close_fiscal_period refuses open prior periods in the dry run too,
 *       with the same typed sentence as the live call.
 *   B6  The MCP period controls are owner/admin only, as over HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import yearEnd from '../../pages/api/accounting/year-end';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members } from './entity-changes.helpers';
import { callRoute } from './r035-approval.helpers';
import { cleanupAudit } from './audit-snapshots.helpers';
import { mcpRun } from './audit-snapshots-mcp.helpers';
import { closeFiscalPeriodTool, reopenFiscalPeriodTool, yearEndCloseTool } from '../../src/lib/mcp/tools/writeFiscalPeriods';
import { details, gateFixture } from './helpers/periodCloseGateFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const fx = gateFixture(pool, companies, tokens);
let other = '';

beforeAll(async () => { [fx.owner, other] = await members(pool, tokens, 2); });
afterAll(() => cleanupAudit(pool, companies, [fx.owner, other]));

const closeAll = (periods: string[]) => pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = ANY($1)", [periods]);
const MCP_SCOPES = ['write:journals', 'write:post'];

describe('B1: a period is judged again before it is locked', () => {
  it('Lock refuses a period a bank line landed in after its close; locks once reconciled', async () => {
    const b = await fx.books();
    expect((await fx.action(b.c, { action: 'close', id: b.periods[0], confirm: true })).state.statusCode).toBe(200);
    const line = await fx.unreconciledLine(b, '2026-01-25');
    const refused = await fx.action(b.c, { action: 'lock', id: b.periods[0], confirm: true });
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    expect(details(refused.state.body).periods[0]!.blockers.map((x) => x.key)).toEqual(['bank_reconciled']);
    expect(JSON.stringify(refused.state.body)).toContain('P1 2026 cannot be locked');
    expect((await fx.statuses(b.c))[0]).toBe('closed');

    await fx.reconcile(line);
    expect((await fx.action(b.c, { action: 'lock', id: b.periods[0], confirm: true })).state.statusCode).toBe(200);
    expect((await fx.statuses(b.c))[0]).toBe('locked');
  });

  it('Bulk Lock refuses a period closed before the gate existed (status set directly), with its checks', async () => {
    const b = await fx.books();
    await closeAll([b.periods[0]!]);
    await fx.unreconciledLine(b, '2026-01-02');
    const res = await fx.action(b.c, { action: 'bulk_lock', ids: [b.periods[0]], confirm: true });
    const row = (res.state.body as { data: { results: Array<Record<string, unknown>> } }).data.results[0];
    expect(row).toMatchObject({ ok: false, code: 'PERIOD_CLOSE_NOT_READY' });
    expect((await fx.statuses(b.c))[0]).toBe('closed');
  });

  it('year-end close: preview and close refuse a closed period that fails a check; nothing posts or locks', async () => {
    const b = await fx.books();
    await fx.retainedEarnings(b.c);
    await closeAll(b.periods);
    const line = await fx.unreconciledLine(b, '2026-05-10');

    const preview = await callRoute(yearEnd, tokens[fx.owner]!, b.c, 'GET', undefined, '/api/accounting/year-end', { preview: '2026' });
    expect(JSON.stringify(preview.state.body)).toMatch(/cannot be locked: 1 period failed the close checks \(P5 2026: Bank reconciled\)/);

    const refused = await fx.yearEndClose(b.c);
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    expect(details(refused.state.body)).toMatchObject({ code: 'PERIOD_CLOSE_NOT_READY', fiscalYear: 2026,
      periods: [{ periodId: b.periods[4], blockers: [{ key: 'bank_reconciled' }] }] });
    expect(await fx.statuses(b.c)).not.toContain('locked');
    const journals = await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND source = 'year_end'", [b.c]);
    expect(journals.rows[0].n).toBe(0);

    await fx.reconcile(line);
    expect((await fx.yearEndClose(b.c)).state.statusCode).toBe(200);
    expect(new Set(await fx.statuses(b.c))).toEqual(new Set(['locked']));
  });
});

describe('T1: a check that could not be computed blocks', () => {
  it('open AR invoices and no AR control account: ar_ties "Could not compute", the close is refused', async () => {
    const b = await fx.books();
    const customer = crypto.randomUUID();
    await pool.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Gate customer')`, [customer, b.c]);
    await pool.query(`INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status,
                        total_amount, amount_paid, created_by)
                      VALUES ($1, $2, $2, 'GATE-1', DATE '2026-01-10', DATE '2026-01-20', 'sent', 500, 0, $3)`, [b.c, customer, fx.owner]);
    const res = await fx.action(b.c, { action: 'close', id: b.periods[0], confirm: true });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    const ar = details(res.state.body).periods[0]!.blockers.find((x) => x.key === 'ar_ties');
    expect(ar?.reason).toMatch(/^Could not compute — /);
    expect((await fx.statuses(b.c))[0]).toBe('open');
  });
});

describe('T3: another company\'s period', () => {
  it('close, bulk_close and close_year never reach it', async () => {
    const mine = await fx.books();
    const theirs = await fx.books([[other, 'owner']]);
    const close = await fx.action(mine.c, { action: 'close', id: theirs.periods[0], confirm: true });
    expect(close.state.statusCode).toBe(400);
    expect(JSON.stringify(close.state.body)).toContain('Fiscal period not found');
    const bulk = await fx.action(mine.c, { action: 'bulk_close', ids: [theirs.periods[0]], confirm: true });
    expect((bulk.state.body as { data: { results: unknown[] } }).data.results).toEqual([
      { id: theirs.periods[0], ok: false, error: 'Fiscal period not found' }]);
    expect((await fx.action(mine.c, { action: 'close_year', fiscalYear: 2026, confirm: true })).state.statusCode).toBe(200);
    expect(new Set(await fx.statuses(mine.c))).toEqual(new Set(['closed']));
    expect(new Set(await fx.statuses(theirs.c))).toEqual(new Set(['open']));
  });
});

describe('B5 / B6: MCP period controls', () => {
  it('B5: the dry run refuses open prior periods with the live call\'s sentence', async () => {
    const b = await fx.books();
    const run = (dry: boolean) => mcpRun(pool, [closeFiscalPeriodTool], fx.owner, b.c, 'owner', 'close_fiscal_period',
      { fiscal_period_id: b.periods[1], ...(dry ? { dry_run: true } : {}) }, MCP_SCOPES);
    const sentence = 'P2 2026 cannot be closed: prior periods are still open (P1 2026). Close them first.';
    for (const dry of [true, false]) {
      const out = await run(dry);
      expect(out.isError, `dry=${dry}`).toBe(true);
      expect(out.content[0]!.text).toContain(sentence);
    }
    expect((await fx.statuses(b.c))[1]).toBe('open');
  });

  it.each([
    ['close_fiscal_period', closeFiscalPeriodTool], ['reopen_fiscal_period', reopenFiscalPeriodTool], ['year_end_close', yearEndCloseTool],
  ] as const)('B6 %s: manager and viewer refused; owner and admin reach it', async (name, tool) => {
    const b = await fx.books();
    const args = name === 'year_end_close' ? { fiscal_year: 2026, dry_run: true } : { fiscal_period_id: b.periods[0], dry_run: true };
    for (const role of ['manager', 'viewer']) {
      const out = await mcpRun(pool, [tool], fx.owner, b.c, role, name, args, MCP_SCOPES);
      expect(out.isError, role).toBe(true);
      expect(out.content[0]!.text).toMatch(/only by the owner and admin roles/);
    }
    for (const role of ['owner', 'admin']) {
      const out = await mcpRun(pool, [tool], fx.owner, b.c, role, name, args, MCP_SCOPES);
      expect(out.content[0]!.text, role).not.toMatch(/only by the owner and admin roles/);
    }
  });
});

describe('N3: the year-end dry run waits no longer than the live close', () => {
  it('with bank_transactions held, the preview and the MCP dry run answer busy within the 5 s budget, not after the holder lets go', async () => {
    const b = await fx.books();
    await fx.retainedEarnings(b.c);
    await closeAll(b.periods);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE bank_transactions IN ACCESS EXCLUSIVE MODE');
      const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 9000))]);
      const preview = await within(callRoute(yearEnd, tokens[fx.owner]!, b.c, 'GET', undefined, '/api/accounting/year-end', { preview: '2026' }));
      expect(preview).not.toBe('hung');
      expect((preview as { state: { statusCode: number } }).state.statusCode).toBe(503);
      const dry = await within(mcpRun(pool, [yearEndCloseTool], fx.owner, b.c, 'owner', 'year_end_close', { fiscal_year: 2026, dry_run: true }, MCP_SCOPES));
      expect(dry).not.toBe('hung');
      expect((dry as { isError?: boolean }).isError).toBe(true);
      expect((dry as { content: { text: string }[] }).content[0]!.text).toMatch(/Another request is holding a lock the year-end close needs/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 60_000);
});
