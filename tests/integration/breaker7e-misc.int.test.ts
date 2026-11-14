/**
 * BREAKER 7e: UI Generate racing the MCP run, cross-company, weekly end_date mid-month, quarterly, year boundary.
 * ci-integration-skip: none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { createRecurringJournalTool, deactivateRecurringJournalTool } from '@/lib/mcp/tools/writeRecurringJournals';
import { runRecurringJournal } from '@/modules/accounting/services/gl/recurringJournalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';
import { backendPid, waitUntilBlocked } from './helpers/lockWait';
import {
  calendar, company, ctxFor, day, journals, onClient, parsed, plantTemplate, request, templateState,
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
afterAll(() => cleanupPr6(pool, companies, [user]));

const run = (co: Co, period: string, scopes = POST) => request(pool, co, user, () => runRecurringJournalsTool.handler(
  { period, idempotency_key: crypto.randomUUID() }, ctxFor(co, user, scopes)));

describe('breaker7e misc', () => {
  it('UI Generate holding the lock, MCP run waits, then generates nothing twice', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });
    const a = await pool.connect(); const b = await pool.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await onClient(a, co, user, () => runRecurringJournal(co.c, t, user));
      const pid = await backendPid(b);
      const p = onClient(b, co, user, () => runRecurringJournalsTool.handler(
        { period: cal.prev.period, idempotency_key: crypto.randomUUID() }, ctxFor(co, user, POST)));
      await waitUntilBlocked(pool, pid);
      await a.query('COMMIT');
      const out = parsed(await p);
      await b.query('COMMIT');
      expect(out.generated).toEqual([]);
    } finally { a.release(); b.release(); }
    expect((await journals(pool, co)).length).toBe(1);
    expect((await templateState(pool, t)).runs).toBe(1);
  });

  it('cross-company: deactivate and run cannot reach another company template', async () => {
    const mine = await company(pool, user, [cal.prev, cal.cur], companies);
    const theirs = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, theirs, user, { name: 'Theirs', frequency: 'monthly', next: day(cal.prev, 15) });
    const r = await request(pool, mine, user, () => deactivateRecurringJournalTool.handler(
      { recurring_journal_id: t, idempotency_key: crypto.randomUUID() }, ctxFor(mine, user, POST)));
    expect(r.isError).toBe(true);
    await run(mine, cal.prev.period);
    expect(await templateState(pool, t)).toMatchObject({ status: 'active', runs: 0 });
    const c = await request(pool, mine, user, () => createRecurringJournalTool.handler({
      name: 'X', frequency: 'monthly', start_date: day(cal.prev, 3), idempotency_key: crypto.randomUUID(),
      lines: [{ account_id: theirs.exp, debit: 10, credit: 0 }, { account_id: mine.accrual, debit: 0, credit: 10 }],
    }, ctxFor(mine, user, POST)));
    expect(c.isError).toBe(true);
  });

  it('weekly with end_date mid-month generates up to end_date only, then completes', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, {
      name: 'Wk', frequency: 'weekly', next: day(cal.prev, 1), endDate: day(cal.prev, 15),
    });
    await run(co, cal.prev.period);
    expect((await journals(pool, co)).map((j) => j.entry_date)).toEqual([day(cal.prev, 1), day(cal.prev, 8), day(cal.prev, 15)]);
    expect((await templateState(pool, t)).status).toBe('completed');
  });

  it('quarterly: once in its month, nothing in the next month', async () => {
    const co = await company(pool, user, [cal.before, cal.prev, cal.cur], companies);
    const t = await plantTemplate(pool, co, user, { name: 'Q', frequency: 'quarterly', next: day(cal.before, 31 > cal.before.lastDay ? cal.before.lastDay : 31) });
    await run(co, cal.before.period);
    await run(co, cal.before.period);
    const nx = parsed(await run(co, cal.prev.period));
    expect(nx.generated).toEqual([]);
    expect((await journals(pool, co)).length).toBe(1);
    expect((await templateState(pool, t)).runs).toBe(1);
  });

  it('MCP-created draft-only template, then UI Generate: stays a draft', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    const c = parsed(await request(pool, co, user, () => createRecurringJournalTool.handler({
      name: 'D', frequency: 'monthly', start_date: day(cal.prev, 3), idempotency_key: crypto.randomUUID(),
      lines: [{ account_id: co.exp, debit: 10, credit: 0 }, { account_id: co.accrual, debit: 0, credit: 10 }],
    }, ctxFor(co, user, ['write:journals']))));
    const id = String(c.recurring_journal_id);
    await request(pool, co, user, () => runRecurringJournal(co.c, id, user));
    expect((await journals(pool, co)).map((j) => j.status)).toEqual(['draft']);
  });
});
