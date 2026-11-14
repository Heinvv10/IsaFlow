/**
 * BREAKER 7e: the dry run must leave no trace (entry numbers, fiscal years) and list exactly what the live run does.
 * ci-integration-skip: none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';
import {
  calendar, company, ctxFor, day, parsed, plantTemplate, request, type Calendar, type Co,
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

const run = (co: Co, period: string, dry: boolean, scopes = POST) => request(pool, co, user, () =>
  runRecurringJournalsTool.handler({ period, idempotency_key: crypto.randomUUID(), dry_run: dry }, ctxFor(co, user, scopes)));

const numbers = async (co: Co) => (await pool.query(
  'SELECT entry_number FROM gl_journal_entries WHERE company_id=$1 ORDER BY entry_number', [co.c])).rows.map((r) => String(r.entry_number));

describe('breaker7e dry vs live', () => {
  it('dry run then live gives the same entry numbers as live alone, and the same list', async () => {
    const a = await company(pool, user, [cal.prev, cal.cur], companies);
    const b = await company(pool, user, [cal.prev, cal.cur], companies);
    for (const co of [a, b]) {
      await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });
      await plantTemplate(pool, co, user, { name: 'Wk', frequency: 'weekly', next: day(cal.prev, 1), autoPost: false });
    }
    const dry = parsed(await run(a, cal.prev.period, true));
    await run(a, cal.prev.period, true);
    const live = parsed(await run(a, cal.prev.period, false));
    await run(b, cal.prev.period, false);
    const strip = (g: unknown) => (g as { run_date: string; status: string; template_name: string }[])
      .map((x) => `${x.template_name}|${x.run_date}|${x.status}`).sort();
    expect(strip(dry.would_generate)).toEqual(strip(live.generated));
    const na = await numbers(a); const nb = await numbers(b);
    expect(na).toEqual(nb);
  });

  it('dry run with no fiscal year leaves no fiscal year behind; live creates one and generates', async () => {
    const co = await company(pool, user, [], companies);
    await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });
    const dry = parsed(await run(co, cal.prev.period, true));
    const fy = (await pool.query('SELECT COUNT(*)::INT n FROM fiscal_periods WHERE company_id=$1', [co.c])).rows[0].n;
    const live = parsed(await run(co, cal.prev.period, false));
    expect({ fy, dry: (dry.would_generate as unknown[]).length, dryskip: dry.skipped })
      .toEqual({ fy: 0, dry: (live.generated as unknown[]).length, dryskip: live.skipped });
  });

  it('draft-only token: dry and live agree, nothing posted', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });
    await plantTemplate(pool, co, user, { name: 'D', frequency: 'monthly', next: day(cal.prev, 15), autoPost: false });
    const dry = parsed(await run(co, cal.prev.period, true, ['write:journals']));
    const live = parsed(await run(co, cal.prev.period, false, ['write:journals']));
    expect(dry.skipped).toEqual(live.skipped);
    const posted = (await pool.query("SELECT COUNT(*)::INT n FROM gl_journal_entries WHERE company_id=$1 AND status='posted'", [co.c])).rows[0].n;
    expect(posted).toBe(0);
  });
});
