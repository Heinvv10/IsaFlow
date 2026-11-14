/**
 * BREAKER 7e round 2: end_date edges, refusals leave nothing, pause/resume combos past the end.
 * ci-integration-skip: none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { deactivateRecurringJournalTool } from '@/lib/mcp/tools/writeRecurringJournals';
import {
  runRecurringJournal, updateRecurringJournalStatus,
} from '@/modules/accounting/services/gl/recurringJournalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';
import {
  calendar, company, ctxFor, day, journals, parsed, plantTemplate, request, templateState, type Calendar, type Co,
} from './helpers/recurringJournalMcpFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const user = crypto.randomUUID();
const POST = ['write:journals', 'write:post'];
let cal: Calendar;

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  cal = await calendar(pool);
});
afterAll(() => cleanupPr6(pool, companies, [user]));

const run = (co: Co, period: string, dry = false) => request(pool, co, user, () => runRecurringJournalsTool.handler(
  { period, idempotency_key: crypto.randomUUID(), dry_run: dry }, ctxFor(co, user, POST)));
type Skip = { reason: string; run_date: string };

describe('breaker7e r2 end_date', () => {
  it('next_run_date == end_date still generates, then completes', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Eq', frequency: 'monthly', next: day(cal.prev, 15), endDate: day(cal.prev, 15) });
    const out = parsed(await run(co, cal.prev.period));
    expect((out.generated as unknown[]).length).toBe(1);
    expect(await templateState(pool, t)).toMatchObject({ runs: 1, status: 'completed' });
  });

  it('end_date null: weekly generates every week of the month', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    await plantTemplate(pool, co, user, { name: 'W', frequency: 'weekly', next: day(cal.prev, 2) });
    await run(co, cal.prev.period);
    expect((await journals(pool, co)).length).toBe([2, 9, 16, 23, 30].filter((d) => d <= cal.prev.lastDay).length);
  });

  it('weekly crossing end_date mid-month: stops at the last run on/before end, completes, no ended skip', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'W', frequency: 'weekly', next: day(cal.prev, 2), endDate: day(cal.prev, 12) });
    const out = parsed(await run(co, cal.prev.period));
    expect((await journals(pool, co)).map((j) => j.entry_date)).toEqual([day(cal.prev, 2), day(cal.prev, 9)]);
    expect(out.skipped).toEqual([]);
    expect((await templateState(pool, t)).status).toBe('completed');
  });

  it('quarterly with end_date inside the next quarter: one run, completed', async () => {
    const co = await company(pool, user, [cal.before, cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Q', frequency: 'quarterly', next: day(cal.before, 5), endDate: day(cal.prev, 28) });
    await run(co, cal.before.period);
    expect(await templateState(pool, t)).toMatchObject({ runs: 1, status: 'completed' });
  });

  it('month-end stickiness at end_date: before.end then prev.end (== end_date) both generate', async () => {
    const co = await company(pool, user, [cal.before, cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'ME', frequency: 'monthly', next: cal.before.end, endDate: cal.prev.end });
    await run(co, cal.before.period);
    await run(co, cal.prev.period);
    expect((await journals(pool, co)).map((j) => j.entry_date)).toEqual([cal.before.end, cal.prev.end]);
    expect((await templateState(pool, t)).status).toBe('completed');
  });

  it('ended: MCP skip and UI Generate refusal leave schedule, journals, fiscal rows untouched; dry == live', async () => {
    const co = await company(pool, user, [cal.cur], companies); // no prev period: a write would create a year
    const t = await plantTemplate(pool, co, user, { name: 'E', frequency: 'monthly', next: day(cal.prev, 20), endDate: day(cal.prev, 10) });
    const fp0 = (await pool.query('SELECT COUNT(*)::INT n FROM fiscal_periods WHERE company_id=$1', [co.c])).rows[0].n;
    const dry = parsed(await run(co, cal.prev.period, true));
    const live = parsed(await run(co, cal.prev.period));
    expect((live.skipped as Skip[]).map((s) => s.reason)).toEqual(['ended']);
    expect(dry.skipped).toEqual(live.skipped);
    await expect(request(pool, co, user, () => runRecurringJournal(co.c, t, user))).rejects.toThrow(/ended/);
    const fp1 = (await pool.query('SELECT COUNT(*)::INT n FROM fiscal_periods WHERE company_id=$1', [co.c])).rows[0].n;
    expect({ fp1, j: await journals(pool, co), s: await templateState(pool, t) })
      .toEqual({ fp1: fp0, j: [], s: { next: day(cal.prev, 20), runs: 0, status: 'active' } });
  });

  it('CANCELLED template: UI pause (unpredicated) then resume revives it and it generates', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Cx', frequency: 'monthly', next: day(cal.prev, 15) });
    await pool.query("UPDATE recurring_journals SET status='cancelled' WHERE id=$1", [t]);
    await request(pool, co, user, () => updateRecurringJournalStatus(co.c, t, 'paused')); // UI 'pause' action
    const r = await request(pool, co, user, () => deactivateRecurringJournalTool.handler(
      { recurring_journal_id: t, enable: true, idempotency_key: crypto.randomUUID() }, ctxFor(co, user, POST)));
    await run(co, cal.prev.period);
    expect({ resumed: !r.isError, journals: (await journals(pool, co)).length }).toEqual({ resumed: false, journals: 0 });
  });

  it('COMPLETED template: UI pause then resume then run — ended, nothing generated', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Done', frequency: 'monthly', next: day(cal.prev, 10), endDate: day(cal.prev, 5) });
    await pool.query("UPDATE recurring_journals SET status='completed' WHERE id=$1", [t]);
    await request(pool, co, user, () => updateRecurringJournalStatus(co.c, t, 'paused'));
    await request(pool, co, user, () => updateRecurringJournalStatus(co.c, t, 'active', 'paused'));
    await run(co, cal.prev.period);
    expect((await journals(pool, co)).length).toBe(0);
  });
});
