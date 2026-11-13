/**
 * The two edits of a recurring journal template, against a real database (MCP brief step 7, breaker round 2):
 *
 *  - STATUS: only active -> paused, paused -> active, active | paused -> cancelled. A cancelled or completed template
 *    stays so on every path — a cancelled one paused and then resumed used to come back to life and generate.
 *  - NEXT RUN DATE (the page's PUT): never into a frequency period already generated (`last_run_date`'s month or
 *    week, the claim now records the run's own date) — moving back, or merely later in the same month, generated it a
 *    second time — unless within or after the current next run's period; nor after the end date.
 *
 * ci-integration-skip: none — every case runs on the throwaway cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { frequencyPeriodLabel } from '@/modules/accounting/services/gl/recurringSchedule';
import {
  runRecurringJournal, updateRecurringJournalStatus, updateRecurringJournalTemplate,
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
let cal: Calendar;

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  cal = await calendar(pool);
});
afterAll(() => cleanupPr6(pool, companies, [user])); // ends the pool too

const run = (co: Co, period: string) => request(pool, co, user, () => runRecurringJournalsTool.handler(
  { period, idempotency_key: crypto.randomUUID() }, ctxFor(co, user, ['write:journals', 'write:post'])));
const setStatus = async (id: string, status: string) =>
  pool.query('UPDATE recurring_journals SET status = $2 WHERE id = $1', [id, status]);

describe('recurring journal status moves', () => {
  it.each(['cancelled', 'completed'])('a %s template cannot be paused, resumed or cancelled — it stays so', async (final) => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'F', frequency: 'monthly', next: day(cal.prev, 15) });
    await setStatus(t, final);
    for (const target of ['paused', 'active', 'cancelled'] as const) {
      const change = await request(pool, co, user, () => updateRecurringJournalStatus(co.c, t, target));
      expect(change).toEqual({ changed: false, current: final });
    }
    await run(co, cal.prev.period);
    expect(await journals(pool, co)).toEqual([]);
    expect((await templateState(pool, t)).status).toBe(final);
  });

  it('the allowed moves: active -> paused -> active -> cancelled', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'M', frequency: 'monthly', next: day(cal.prev, 15) });
    const move = (s: 'paused' | 'active' | 'cancelled') => request(pool, co, user, () => updateRecurringJournalStatus(co.c, t, s));
    expect(await move('active')).toEqual({ changed: false, current: 'active' }); // resume needs paused
    expect(await move('paused')).toEqual({ changed: true });
    expect(await move('paused')).toEqual({ changed: false, current: 'paused' });
    expect(await move('active')).toEqual({ changed: true });
    // `from` narrows the move to the status the caller read: active may be cancelled, but not by one who read paused.
    expect(await request(pool, co, user, () => updateRecurringJournalStatus(co.c, t, 'cancelled', 'paused')))
      .toEqual({ changed: false, current: 'active' });
    expect(await move('cancelled')).toEqual({ changed: true });
    expect((await templateState(pool, t)).status).toBe('cancelled');
  });
});

describe('recurring journal next run date edits', () => {
  it('monthly: no next run anywhere in a month already generated; re-running that month generates nothing', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });
    await run(co, cal.prev.period);
    expect((await pool.query('SELECT last_run_date::TEXT AS d FROM recurring_journals WHERE id = $1', [t])).rows[0].d)
      .toBe(day(cal.prev, 15)); // the run's own date, not the day it was generated

    // Back onto the run, before it, and LATER in the same month (ran the 15th, moved to the 16th) — all that month.
    for (const back of [day(cal.prev, 15), day(cal.prev, 1), day(cal.prev, 16)]) {
      await expect(request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: back })))
        .rejects.toThrow(`This template last generated on ${day(cal.prev, 15)}: ${frequencyPeriodLabel(back, 'monthly')} `
          + 'has already been generated for this template — choose a date in a later month (post a manual journal for a '
          + 'second run).');
    }
    expect((await templateState(pool, t)).next).toBe(day(cal.cur, 15));
    expect(parsed(await run(co, cal.prev.period)).generated).toEqual([]);
    expect(await journals(pool, co)).toHaveLength(1);

    // Switching to weekly in the same edit does not open the month up: the period is the coarser frequency's.
    await expect(request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user,
      { frequency: 'weekly', nextRunDate: day(cal.prev, 22) }))).rejects.toThrow('choose a date in a later month');
    expect(await templateState(pool, t)).toMatchObject({ next: day(cal.cur, 15) });
    // Any date in a later month is an ordinary edit — earlier in the next month than the schedule had it, too.
    await request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: day(cal.cur, 1) }));
    expect((await templateState(pool, t)).next).toBe(day(cal.cur, 1));
  });

  it('weekly: no next run in an ISO week already generated; the next week is fine', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur, cal.next], companies);
    // The first Monday of last month, so its ISO week is wholly inside the month.
    const first = new Date(`${cal.prev.start}T00:00:00Z`);
    first.setUTCDate(first.getUTCDate() + ((8 - first.getUTCDay()) % 7));
    const iso = (offset: number) => new Date(first.getTime() + offset * 86400000).toISOString().slice(0, 10);
    const t = await plantTemplate(pool, co, user, { name: 'Wk', frequency: 'weekly', next: iso(0) });
    await request(pool, co, user, () => runRecurringJournal(co.c, t, user));
    expect(await templateState(pool, t)).toMatchObject({ next: iso(7), runs: 1 });

    await expect(request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: iso(3) })))
      .rejects.toThrow(`This template last generated on ${iso(0)}: The week of ${iso(0)} has already been generated for this `
        + 'template — choose a date in a later week');
    // Nor does switching to monthly: a monthly run in a month that already has a weekly one is refused.
    await expect(request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user,
      { frequency: 'monthly', nextRunDate: iso(9) }))).rejects.toThrow(`${frequencyPeriodLabel(iso(9), 'monthly')} has already`);
    await request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: iso(9) }));
    expect((await templateState(pool, t)).next).toBe(iso(9));
    expect(await journals(pool, co)).toHaveLength(1);
  });

  it('cannot move the next run past the end date; a template with no run yet may move anywhere before it', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, {
      name: 'Ends', frequency: 'monthly', next: day(cal.prev, 15), endDate: day(cal.cur, 10),
    });
    await expect(request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: day(cal.cur, 11) })))
      .rejects.toThrow(`after this template's end date (${day(cal.cur, 10)})`);
    expect((await templateState(pool, t)).next).toBe(day(cal.prev, 15));
    await request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: day(cal.prev, 1) }));
    expect((await templateState(pool, t)).next).toBe(day(cal.prev, 1));
  });
});
