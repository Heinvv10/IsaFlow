/**
 * One run per period of a template's frequency, enforced where runs are MADE (recurringJournalPeriods, breaker 7e
 * round 4), against a real database:
 *
 *  - every generated journal carries source_record_id = the template, and a run whose period already holds a live one
 *    is refused — the UI Generate (400) and the MCP run (skip `period_already_generated`, dry run alike);
 *  - reversing that journal frees the period; deleting the draft frees it;
 *  - a legacy template (no linked journal) falls back to last_run_date's period, either meaning; a template whose only
 *    linked journal was a deleted draft is in the same position (the known limit).
 *
 * ci-integration-skip: none — every case runs on the throwaway cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { runRecurringJournal } from '@/modules/accounting/services/gl/recurringJournalService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
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

type Skip = { recurring_journal_id: string; reason: string; message: string };

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  cal = await calendar(pool);
});
afterAll(() => cleanupPr6(pool, companies, [user])); // ends the pool too

const run = (co: Co, period: string, dry = false) => request(pool, co, user, () => runRecurringJournalsTool.handler(
  { period, idempotency_key: crypto.randomUUID(), dry_run: dry }, ctxFor(co, user, ['write:journals', 'write:post'])));
/** Put the schedule back into a month by hand — the state any past edit, or a pre-rule PUT, could leave. */
const rewind = (id: string, next: string) => pool.query('UPDATE recurring_journals SET next_run_date = $2::DATE WHERE id = $1', [id, next]);
const inPrev = async (co: Co) => (await journals(pool, co)).filter((j) => j.entry_date.startsWith(cal.prev.period)).length;

describe('one run per period, at generation', () => {
  it('links every run to its template, and refuses a second run in the period — UI, MCP and dry run alike', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 6) });
    await run(co, cal.prev.period);
    const linked = (await pool.query(
      "SELECT source_record_id FROM gl_journal_entries WHERE company_id = $1 AND source = 'auto_recurring'", [co.c])).rows;
    expect(linked).toEqual([{ source_record_id: t }]);

    await rewind(t, day(cal.prev, 27));
    const expected = `This template last generated on ${day(cal.prev, 6)}`;
    for (const dry of [true, false]) {
      const out = parsed(await run(co, cal.prev.period, dry));
      expect(out.skipped as Skip[]).toMatchObject([{ recurring_journal_id: t, reason: 'period_already_generated' }]);
      expect((out.skipped as Skip[])[0]!.message).toContain(expected);
      expect(out.skipped as Skip[]).toHaveLength(1);
    }
    await expect(request(pool, co, user, () => runRecurringJournal(co.c, t, user))).rejects.toThrow(expected);
    expect(await inPrev(co)).toBe(1);
    expect(await templateState(pool, t)).toMatchObject({ next: day(cal.prev, 27), runs: 1 });
  });

  it('reversing the generated journal frees its period', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Rev', frequency: 'monthly', next: day(cal.prev, 6) });
    await run(co, cal.prev.period);
    const [je] = await journals(pool, co);
    await request(pool, co, user, () => reverseJournalEntry(co.c, je!.id, user));
    await rewind(t, day(cal.prev, 27));
    const out = parsed(await run(co, cal.prev.period));
    expect(out.generated).toMatchObject([{ recurring_journal_id: t, run_date: day(cal.prev, 27) }]);
  });

  it('deleting the generated draft frees its period', async () => {
    const co = await company(pool, user, [cal.before, cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Del', frequency: 'monthly', next: day(cal.before, 6), autoPost: false });
    await run(co, cal.before.period);
    await run(co, cal.prev.period);
    const draft = (await journals(pool, co)).find((j) => j.entry_date === day(cal.prev, 6))!;
    expect(draft.status).toBe('draft');
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [draft.id]);
    await pool.query('DELETE FROM gl_journal_entries WHERE id = $1', [draft.id]);
    await rewind(t, day(cal.prev, 20));
    expect(parsed(await run(co, cal.prev.period)).generated).toMatchObject([{ run_date: day(cal.prev, 20) }]);
    expect(await inPrev(co)).toBe(1);
  });

  it('legacy (no linked journal): last_run_date\'s period counts as generated, under either meaning', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Old', frequency: 'monthly', next: day(cal.prev, 25) });
    // A run generated before the link existed: no source_record_id; last_run_date = the day it was generated.
    await pool.query('UPDATE recurring_journals SET last_run_date = $2::DATE, run_count = 1 WHERE id = $1', [t, day(cal.prev, 9)]);
    const out = parsed(await run(co, cal.prev.period));
    expect(out.skipped as Skip[]).toMatchObject([{ reason: 'period_already_generated' }]);
    expect((out.skipped as Skip[])[0]!.message).toContain(`last generated on ${day(cal.prev, 9)}`);
    expect(await journals(pool, co)).toEqual([]);
    // A later period is open.
    await rewind(t, day(cal.cur, 1));
    expect(parsed(await run(co, cal.cur.period)).generated).toMatchObject([{ run_date: day(cal.cur, 1) }]);
  });
});
