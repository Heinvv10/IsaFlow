/**
 * BREAKER 7e round 4: frequency-only edits are unchecked, so a run lands in an already-generated period.
 * ci-integration-skip: none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { updateRecurringJournalTemplate } from '@/modules/accounting/services/gl/recurringJournalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';
import {
  calendar, company, ctxFor, day, journals, plantTemplate, request, type Calendar, type Co,
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
  request(pool, co, user, () => updateRecurringJournalTemplate(co.c, id, user, edit)).then(() => 'ok', (e: Error) => `refused: ${e.message.slice(0, 60)}`);
const inPrev = async (co: Co) => (await journals(pool, co)).filter((j) => j.entry_date.startsWith(cal.prev.period)).length;

describe('breaker7e r4', () => {
  it('A: monthly → weekly (freq only) → next into the generated month → monthly (freq only): October twice', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'A', frequency: 'monthly', next: day(cal.prev, 6) });
    await run(co, cal.prev.period); // prev/06 generated; next cur/06
    const steps = [await put(co, t, { frequency: 'weekly' }), await put(co, t, { nextRunDate: day(cal.prev, 27) }),
      await put(co, t, { frequency: 'monthly' })];
    await run(co, cal.prev.period);
    expect({ steps, inPrev: await inPrev(co) }).toEqual({ steps: expect.anything(), inPrev: 1 });
  });

  it('B: weekly template mid-month, frequency-only switch to monthly adds a monthly run to a generated month', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'B', frequency: 'weekly', next: day(cal.prev, 1) });
    // generate the first two weeks only (as if run mid-month): run, then stop by pausing via end of loop
    await pool.query("UPDATE recurring_journals SET next_run_date=$2::DATE, last_run_date=$3::DATE, run_count=2 WHERE id=$1",
      [t, day(cal.prev, 15), day(cal.prev, 8)]);
    const step = await put(co, t, { frequency: 'monthly' });
    await run(co, cal.prev.period);
    // month already generated at weekly (1st, 8th); a monthly run on the 15th lands in it
    // Orchestrator decision: frequency-only edits are accepted; generation enforces one run per period.
    expect({ step, monthlyRunsInPrev: await inPrev(co) }).toEqual({ step: 'ok', monthlyRunsInPrev: 0 });
  });

  it('C: legacy exception on a NEW-style row: freq-only switch then next inside the last run\'s month is allowed', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'C', frequency: 'monthly', next: day(cal.prev, 6) });
    await run(co, cal.prev.period); // last prev/06 (new rule), next cur/06
    const s1 = await put(co, t, { frequency: 'weekly' });
    const s2 = await put(co, t, { nextRunDate: day(cal.prev, 20) }); // week after last: allowed at weekly
    const s3 = await put(co, t, { frequency: 'monthly' });
    const s4 = await put(co, t, { nextRunDate: day(cal.prev, 27) }); // month == last's month; legacy exception lets it through
    await run(co, cal.prev.period);
    expect({ s1, s2, s3, s4, inPrev: await inPrev(co) }).toEqual({ s1: 'ok', s2: 'ok', s3: 'ok', s4: expect.stringMatching(/refused/), inPrev: 1 });
  });
});
