/**
 * BREAKER 7e round 3: revive / generate-twice through status moves and PUT edits; edits a person cannot escape.
 * ci-integration-skip: none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import {
  runRecurringJournal, updateRecurringJournalStatus, updateRecurringJournalTemplate,
} from '@/modules/accounting/services/gl/recurringJournalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';
import {
  calendar, company, ctxFor, day, journals, plantTemplate, request, templateState, type Calendar, type Co,
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

const run = (co: Co, period: string) => request(pool, co, user, () => runRecurringJournalsTool.handler(
  { period, idempotency_key: crypto.randomUUID() }, ctxFor(co, user, POST)));
const put = (co: Co, id: string, edit: Record<string, string>) =>
  request(pool, co, user, () => updateRecurringJournalTemplate(co.c, id, user, edit));
const status = (co: Co, id: string, s: 'paused' | 'active' | 'cancelled') =>
  request(pool, co, user, () => updateRecurringJournalStatus(co.c, id, s));

describe('breaker7e r3', () => {
  it('cancelled and completed: no sequence of status moves or PUTs revives them', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const cx = await plantTemplate(pool, co, user, { name: 'Cx', frequency: 'monthly', next: day(cal.prev, 15) });
    const done = await plantTemplate(pool, co, user, { name: 'Done', frequency: 'monthly', next: day(cal.prev, 15), endDate: day(cal.prev, 20) });
    await pool.query("UPDATE recurring_journals SET status='cancelled' WHERE id=$1", [cx]);
    await pool.query("UPDATE recurring_journals SET status='completed' WHERE id=$1", [done]);
    for (const id of [cx, done]) {
      for (const s of ['paused', 'active', 'cancelled', 'paused', 'active'] as const) await status(co, id, s);
      await put(co, id, { nextRunDate: day(cal.prev, 16) });
      await request(pool, co, user, () => runRecurringJournal(co.c, id, user)).catch(() => undefined);
    }
    await run(co, cal.prev.period);
    expect((await journals(pool, co)).length).toBe(0);
    expect((await templateState(pool, cx)).status).toBe('cancelled');
    expect((await templateState(pool, done)).status).toBe('completed');
  });

  it('paused, PUT next back onto the generated run is refused; resume generates nothing twice', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'R', frequency: 'weekly', next: day(cal.prev, 1) });
    await run(co, cal.prev.period);
    const n = (await journals(pool, co)).length;
    await status(co, t, 'paused');
    for (const d of [1, 8, 15, 22]) await expect(put(co, t, { nextRunDate: day(cal.prev, d) })).rejects.toThrow(/already been generated/);
    await status(co, t, 'active');
    await run(co, cal.prev.period);
    expect((await journals(pool, co)).length).toBe(n);
  });

  it('monthly: PUT forward within the month, run, PUT back into the same month — October generated twice?', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'M', frequency: 'monthly', next: day(cal.prev, 10) });
    await run(co, cal.prev.period); // generates prev/10, next = cur/10
    // A person moves the next run back to prev/20 (after the last run, so allowed) and runs prev again.
    let refused = false;
    try { await put(co, t, { nextRunDate: day(cal.prev, 20) }); } catch { refused = true; }
    await run(co, cal.prev.period);
    const inPrev = (await journals(pool, co)).filter((j) => j.entry_date.startsWith(cal.prev.period)).length;
    expect({ refused, inPrev }).toEqual({ refused: true, inPrev: 1 });
  });

  it('old-rule last_run_date (generation day) after end_date: a person cannot correct next_run_date at all', async () => {
    const co = await company(pool, user, [cal.before, cal.prev, cal.cur], companies);
    // last run under the old rule: occurrence before/28 generated today; next prev/28; ends prev/28
    const t = await plantTemplate(pool, co, user, { name: 'Old', frequency: 'monthly', next: day(cal.prev, 28), endDate: day(cal.prev, 28) });
    await pool.query('UPDATE recurring_journals SET last_run_date=$2::DATE, run_count=1 WHERE id=$1', [t, cal.today]);
    // The person wants the final run on prev/25 instead of prev/28 (after the real last occurrence, before end).
    let err = '';
    try { await put(co, t, { nextRunDate: day(cal.prev, 25) }); } catch (e) { err = (e as Error).message; }
    expect(err).toBe('');
  });
});
