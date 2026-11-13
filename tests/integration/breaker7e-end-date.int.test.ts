/**
 * BREAKER 7e: run_recurring_journals generates a run dated AFTER the template's end_date.
 * ci-integration-skip: none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { updateRecurringJournalStatus } from '@/modules/accounting/services/gl/recurringJournalService';
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

const run = (co: Co, period: string) => request(pool, co, user, () => runRecurringJournalsTool.handler(
  { period, idempotency_key: crypto.randomUUID() }, ctxFor(co, user, POST)));

describe('breaker7e end_date', () => {
  it('A: an active template whose next run is past its end_date (UI PUT moved next_run_date) generates nothing', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    // State the UI PUT reaches: it edits next_run_date with no end_date check, status stays active.
    const t = await plantTemplate(pool, co, user, {
      name: 'Ended', frequency: 'monthly', next: day(cal.prev, 20), endDate: day(cal.prev, 10),
    });
    const out = parsed(await run(co, cal.prev.period));
    const rows = await journals(pool, co);
    expect({ generated: (out.generated as unknown[]).length, journals: rows.map((j) => j.entry_date) })
      .toEqual({ generated: 0, journals: [] });
    void t;
  });

  it('B: a COMPLETED template resumed through the UI action (unpredicated) is run past its end_date', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, {
      name: 'Done', frequency: 'monthly', next: day(cal.before, 10), endDate: day(cal.before, 10),
    });
    // it ran its last run (before-month) and completed
    await pool.query("UPDATE recurring_journals SET status='completed', next_run_date=$2::DATE, run_count=1 WHERE id=$1",
      [t, day(cal.prev, 10)]);
    // UI 'resume' action: updateRecurringJournalStatus(companyId, id, 'active') with no `from`
    await request(pool, co, user, () => updateRecurringJournalStatus(co.c, t, 'active'));
    const out = parsed(await run(co, cal.prev.period));
    const rows = await journals(pool, co);
    expect({ generated: (out.generated as unknown[]).length, journals: rows.map((j) => j.entry_date),
      state: await templateState(pool, t) }).toMatchObject({ generated: 0, journals: [] });
  });
});
