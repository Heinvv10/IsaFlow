/**
 * The two edits of a recurring journal template, against a real database (MCP brief step 7, breaker round 2):
 *
 *  - STATUS: only active -> paused, paused -> active, active | paused -> cancelled. A cancelled or completed template
 *    stays so on every path — a cancelled one paused and then resumed used to come back to life and generate.
 *  - NEXT RUN DATE (the page's PUT): never on or before the last run generated (`last_run_date`, which the claim now
 *    sets to the run's own date) — that generated the run a second time — nor after the end date.
 *
 * ci-integration-skip: none — every case runs on the throwaway cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import {
  updateRecurringJournalStatus, updateRecurringJournalTemplate,
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
    expect(await move('cancelled')).toEqual({ changed: true });
    expect((await templateState(pool, t)).status).toBe('cancelled');
  });
});

describe('recurring journal next run date edits', () => {
  it('cannot move the next run back onto a run already generated; re-running that month generates nothing', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });
    await run(co, cal.prev.period);
    expect((await pool.query('SELECT last_run_date::TEXT AS d FROM recurring_journals WHERE id = $1', [t])).rows[0].d)
      .toBe(day(cal.prev, 15)); // the run's own date, not the day it was generated

    for (const back of [day(cal.prev, 15), day(cal.prev, 1)]) {
      await expect(request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: back })))
        .rejects.toThrow(`The run dated ${day(cal.prev, 15)} has already been generated`);
    }
    expect((await templateState(pool, t)).next).toBe(day(cal.cur, 15));
    expect(parsed(await run(co, cal.prev.period)).generated).toEqual([]);
    expect(await journals(pool, co)).toHaveLength(1);

    // Forward of the last run is an ordinary edit.
    await request(pool, co, user, () => updateRecurringJournalTemplate(co.c, t, user, { nextRunDate: day(cal.prev, 16) }));
    expect((await templateState(pool, t)).next).toBe(day(cal.prev, 16));
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
