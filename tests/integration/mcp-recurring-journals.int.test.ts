/**
 * run_recurring_journals / create_recurring_journal / deactivate_recurring_journal against a real database
 * (MCP brief step 7). What only a database can prove:
 *
 *  - every run due in the month is generated ONCE, dated its run date, posted or left a draft per template, stamped
 *    as the agent's; the schedule advances; a re-run of the month generates nothing;
 *  - two runs of the same month on two connections at once generate each run exactly once — the second waits on the
 *    first's template lock, then finds nothing due;
 *  - the dry run lists exactly what the live run then generates, and leaves nothing behind;
 *  - a template made by create_recurring_journal generates through the same path; a paused one generates nothing.
 *
 * ci-integration-skip: none — every case runs on the throwaway cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { createRecurringJournalTool, deactivateRecurringJournalTool } from '@/lib/mcp/tools/writeRecurringJournals';
import {
  createRecurringJournal, updateRecurringJournalStatus,
} from '@/modules/accounting/services/gl/recurringJournalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';
import { backendPid, waitUntilBlocked } from './helpers/lockWait';
import {
  calendar, company, ctxFor, day, journals, onClient, parsed, plantTemplate, request, templateState, weeklyDays,
  type Calendar, type Co,
} from './helpers/recurringJournalMcpFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const user = crypto.randomUUID();
const POST = ['write:journals', 'write:post'];
let cal: Calendar;

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  cal = await calendar(pool);
});
afterAll(() => cleanupPr6(pool, companies, [user])); // ends the pool too

/** A monthly posting template on the 15th of last month and a weekly drafting one from its 1st. */
async function twoTemplates(co: Co) {
  const monthly = await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });
  const weekly = await plantTemplate(pool, co, user, {
    name: 'Cleaning', frequency: 'weekly', next: day(cal.prev, 1), autoPost: false, amount: 120,
  });
  return { monthly, weekly };
}

const run = (co: Co, args: Record<string, unknown>, scopes = POST) =>
  request(pool, co, user, () => runRecurringJournalsTool.handler(
    { period: cal.prev.period, idempotency_key: crypto.randomUUID(), ...args }, ctxFor(co, user, scopes)));

describe('run_recurring_journals over a real database', () => {
  it('generates every due run once, dated its run date, posted or draft per template; a re-run generates nothing', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const other = await company(pool, user, [cal.prev, cal.cur], companies);
    const { monthly, weekly } = await twoTemplates(co);
    const foreign = await plantTemplate(pool, other, user, { name: 'Theirs', frequency: 'monthly', next: day(cal.prev, 15) });

    const r = await run(co, {});
    expect(r.isError).toBeFalsy();
    expect(r.wroteNothing).toBeUndefined();
    const weeks = weeklyDays(cal.prev);
    const out = parsed(r) as { generated: { recurring_journal_id: string; run_date: string; status: string; journal_id: string }[] };
    expect(out.generated).toHaveLength(1 + weeks.length);

    const rows = await journals(pool, co);
    expect(rows.map((j) => [j.entry_date, j.status]).sort()).toEqual(
      [[day(cal.prev, 15), 'posted'], ...weeks.map((d) => [d, 'draft'])].sort());
    expect(new Set(rows.map((j) => j.source))).toEqual(new Set(['auto_recurring']));
    expect(new Set(rows.map((j) => j.posting_agent))).toEqual(new Set(['mcp:run_recurring_journals:v1']));
    expect(new Set(out.generated.map((g) => g.journal_id))).toEqual(new Set(rows.map((j) => j.id)));
    const sums = (await pool.query(
      `SELECT SUM(debit)::NUMERIC AS dr, SUM(credit)::NUMERIC AS cr FROM gl_journal_lines WHERE company_id = $1`, [co.c])).rows[0];
    expect(Number(sums.dr)).toBe(500 + 120 * weeks.length);
    expect(Number(sums.cr)).toBe(Number(sums.dr));

    expect(await templateState(pool, monthly)).toMatchObject({ next: day(cal.cur, 15), runs: 1 });
    expect((await templateState(pool, weekly)).runs).toBe(weeks.length);
    expect((await templateState(pool, weekly)).next > cal.prev.end).toBe(true);
    expect(await templateState(pool, foreign)).toMatchObject({ next: day(cal.prev, 15), runs: 0 }); // tenant-scoped

    const again = await run(co, {});
    expect(parsed(again).generated).toEqual([]);
    expect(again.wroteNothing).toBe(true);
    expect(await journals(pool, co)).toHaveLength(rows.length);
  });

  it('two runs of the same month on two connections at once generate each run exactly once', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    await twoTemplates(co);
    const ctx = ctxFor(co, user, POST);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const a = await onClient(first, co, user, () => runRecurringJournalsTool.handler(
        { period: cal.prev.period, idempotency_key: 'race-a' }, ctx));
      const pid = await backendPid(second);
      const pendingB = onClient(second, co, user, () => runRecurringJournalsTool.handler(
        { period: cal.prev.period, idempotency_key: 'race-b' }, ctx));
      await waitUntilBlocked(pool, pid); // B waits on A's template lock: proven, not slept for
      await first.query('COMMIT');
      const b = await pendingB;
      await second.query('COMMIT');

      const expected = 1 + weeklyDays(cal.prev).length;
      expect((parsed(a).generated as unknown[]).length).toBe(expected);
      expect(parsed(b).generated).toEqual([]);
      expect(parsed(b).skipped).toEqual([]);
      expect(await journals(pool, co)).toHaveLength(expected);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  }, 30000);

  it('the dry run lists exactly what the live run then generates, and leaves nothing behind', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const { monthly } = await twoTemplates(co);
    const periodsBefore = Number((await pool.query('SELECT COUNT(*) AS n FROM fiscal_periods WHERE company_id = $1', [co.c])).rows[0].n);

    const dry = await run(co, { dry_run: true });
    expect(dry.wroteNothing).toBe(true);
    const would = (parsed(dry).would_generate as { recurring_journal_id: string; run_date: string; status: string }[])
      .map((g) => [g.recurring_journal_id, g.run_date, g.status]);
    expect(would).toHaveLength(1 + weeklyDays(cal.prev).length);
    expect(await journals(pool, co)).toEqual([]);
    expect(await templateState(pool, monthly)).toMatchObject({ next: day(cal.prev, 15), runs: 0 });
    expect(Number((await pool.query('SELECT COUNT(*) AS n FROM fiscal_periods WHERE company_id = $1', [co.c])).rows[0].n))
      .toBe(periodsBefore);

    const live = await run(co, {});
    expect((parsed(live).generated as { recurring_journal_id: string; run_date: string; status: string }[])
      .map((g) => [g.recurring_journal_id, g.run_date, g.status])).toEqual(would);
  });

  it('a template made by create_recurring_journal generates through the same path; paused, it generates nothing', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const ctx = ctxFor(co, user, ['write:journals']);
    const made = await request(pool, co, user, () => createRecurringJournalTool.handler({
      name: 'Software', frequency: 'monthly', start_date: day(cal.prev, 28), idempotency_key: 'mk-1',
      lines: [{ account_id: co.exp, debit: 99.99, credit: 0, description: 'sub' }, { account_id: co.accrual, debit: 0, credit: 99.99 }],
    }, ctx));
    expect(made.isError).toBeFalsy();
    const id = String(parsed(made).recurring_journal_id);
    const stored = (await pool.query('SELECT auto_post, created_by, company_id FROM recurring_journals WHERE id = $1', [id])).rows[0];
    expect(stored).toMatchObject({ auto_post: false, created_by: user, company_id: co.c });

    const paused = await request(pool, co, user, () => deactivateRecurringJournalTool.handler(
      { recurring_journal_id: id, idempotency_key: 'pause-1' }, ctx));
    expect(parsed(paused)).toMatchObject({ status: 'paused', previous_status: 'active' });
    expect(parsed(await run(co, {}, ['write:journals'])).generated).toEqual([]);

    await request(pool, co, user, () => deactivateRecurringJournalTool.handler(
      { recurring_journal_id: id, enable: true, idempotency_key: 'resume-1' }, ctx));
    const r = await run(co, {}, ['write:journals']); // draft-only: write:post not needed
    expect(parsed(r).generated).toMatchObject([{ recurring_journal_id: id, run_date: day(cal.prev, 28), status: 'draft' }]);
    const lines = (await pool.query(
      `SELECT gl_account_id, debit::NUMERIC AS dr, credit::NUMERIC AS cr FROM gl_journal_lines WHERE company_id = $1
       ORDER BY debit DESC`, [co.c])).rows;
    expect(lines.map((l) => [l.gl_account_id, Number(l.dr), Number(l.cr)]))
      .toEqual([[co.exp, 99.99, 0], [co.accrual, 0, 99.99]]);
  });

  it('the app\'s create still makes posting templates; a status change is predicated on the status read', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const made = await request(pool, co, user, () => createRecurringJournal(co.c, {
      templateName: 'UI', frequency: 'monthly', nextRunDate: day(cal.cur, 1),
      lines: [{ glAccountId: co.exp, debit: 10, credit: 0 }, { glAccountId: co.accrual, debit: 0, credit: 10 }],
    }, user));
    expect(made.autoPost).toBe(true); // migration 989's default: the app never sends the field

    await pool.query("UPDATE recurring_journals SET status = 'cancelled' WHERE id = $1", [made.id]);
    await expect(request(pool, co, user, () => updateRecurringJournalStatus(co.c, made.id, 'active', 'paused')))
      .rejects.toThrow(/status changed concurrently/);
    expect((await templateState(pool, made.id)).status).toBe('cancelled');
  });
});
