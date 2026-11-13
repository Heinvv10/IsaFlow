// general_ledger `universeTotal` (MCP, 2026-11-13). The UNFILTERED posted line count of the window (the tool says so) was
// read off the first returned row, so a call whose filters matched NO line (`search` that hits nothing in a narrow
// window) had no row to read it from and answered 0, with excludedTotal 0: "this period is empty, nothing was
// excluded" for a window that holds lines. Fixture, window 2026-06-10..2026-06-12 (dates are DATEs, no TZ):
//   L0 06-09 'EDGE BEFORE'   L1 06-10 'EDGE START'   L2 06-11 'MIDDLE'   L3 06-12 'EDGE END'   L4 06-13 'EDGE AFTER'
//   Y  06-11 year-end close journal (never in the ledger)   D  06-11 draft (never in the ledger)
//   O  06-11 on the OTHER company: never counted
// Each journal is one debit and one credit line, so the window holds L1..L3 = 6 lines.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { generalLedgerTool } from '@/lib/mcp/tools/generalLedger';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import type { McpToolContext } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
const [company, other, user, bank, exp, bankO, expO] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const START = '2026-06-10';
const END = '2026-06-12';
const WINDOW_LINES = 6;
const ctx: McpToolContext = { userId: user, companyId: company, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null };

async function journal(co: string, a: string, b: string, date: string, desc: string, entryNo: string, status = 'posted', source = 'manual') {
  const je = uuid();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,source,created_by,posted_at,posted_by)
     VALUES($1,$2,$3,$4::DATE,$5,$6,$7,$8,NOW(),$8)`, [je, co, entryNo, date, desc, status, source, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,10,0),($5,$2,$3,$6,0,10)`, [uuid(), co, je, a, uuid(), b]);
}

interface Reply {
  universeTotal: number; excludedTotal: number; rowsTotal: number; completenessFault?: string; rows: Array<{ description: string }>;
}
async function tool(args: Record<string, unknown>): Promise<Reply> {
  const res = await generalLedgerTool.handler({ period_start: START, period_end: END, ...args }, ctx);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0]!.text) as Reply;
}
const svc = (extra: Record<string, unknown> = {}) =>
  getGeneralLedgerLines({ companyId: company, periodStart: START, periodEnd: END, limit: 200, ...extra });

describe('general_ledger universeTotal', () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    for (const [co, name] of [[company, 'GLU A'], [other, 'GLU B']]) await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$5,'GLU1','GLU Bank','asset','bank','debit'),($2,$5,'GLU2','GLU Expense','expense','operating_expense','debit'),
             ($3,$6,'GLU1','GLU Bank O','asset','bank','debit'),($4,$6,'GLU2','GLU Expense O','expense','operating_expense','debit')`,
      [bank, exp, bankO, expO, company, other]);
    await journal(company, exp, bank, '2026-06-09', 'EDGE BEFORE', 'GLU-0');
    await journal(company, exp, bank, '2026-06-10', 'EDGE START', 'GLU-1');
    await journal(company, exp, bank, '2026-06-11', 'MIDDLE', 'GLU-2');
    await journal(company, exp, bank, '2026-06-12', 'EDGE END', 'GLU-3');
    await journal(company, exp, bank, '2026-06-13', 'EDGE AFTER', 'GLU-4');
    await journal(company, exp, bank, '2026-06-11', 'YEAR END', 'GLU-Y', 'posted', YEAR_END_JOURNAL_SOURCE);
    await journal(company, exp, bank, '2026-06-11', 'DRAFT', 'GLU-D', 'draft');
    await journal(other, expO, bankO, '2026-06-11', 'OTHER CO', 'GLU-O');
  });

  afterAll(async () => {
    try {
      for (const co of [company, other]) {
        await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM companies WHERE id=$1', [co]);
      }
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      await pool.end();
    }
  });

  it('unfiltered: window edges are inclusive, universe equals the rows', async () => {
    const r = await tool({});
    expect(r.rowsTotal).toBe(WINDOW_LINES);
    expect(r.universeTotal).toBe(WINDOW_LINES);
    expect(r.excludedTotal).toBe(0);
    expect(r.completenessFault).toBeUndefined();
  });

  it('a search matching lines in the window: universe stays the whole window, the rest is excluded', async () => {
    const r = await tool({ search: 'MIDDLE' });
    expect(r.rowsTotal).toBe(2);
    expect(r.universeTotal).toBe(WINDOW_LINES);
    expect(r.excludedTotal).toBe(WINDOW_LINES - 2);
    expect(r.completenessFault).toBeUndefined();
  });

  it('a search matching NOTHING in the window still reports the window universe (was 0)', async () => {
    const r = await tool({ search: 'NO SUCH TEXT' });
    expect(r.rowsTotal).toBe(0);
    expect(r.universeTotal).toBe(WINDOW_LINES);
    expect(r.excludedTotal).toBe(WINDOW_LINES);
    expect(r.completenessFault).toBeUndefined();
  });

  it('a search that matches only OUTSIDE the window reports the window universe (was 0)', async () => {
    for (const term of ['EDGE BEFORE', 'EDGE AFTER']) {
      const r = await tool({ search: term });
      expect([term, r.rowsTotal, r.universeTotal]).toEqual([term, 0, WINDOW_LINES]);
    }
    const narrow = await tool({ period_start: END, period_end: END, search: 'EDGE START' });
    expect([narrow.rowsTotal, narrow.universeTotal, narrow.excludedTotal]).toEqual([0, 2, 2]);
  });

  it('summary detail and the service agree', async () => {
    const r = await tool({ search: 'NO SUCH TEXT', detail: 'summary' });
    expect(r.universeTotal).toBe(WINDOW_LINES);
    const page = await svc({ search: 'NO SUCH TEXT' });
    expect([page.lineCount, page.universeLineCount]).toEqual([0, WINDOW_LINES]);
  });

  it('a filter that selects nothing by account or source reports the same universe', async () => {
    expect((await svc({ accountCodes: ['NOPE'] })).universeLineCount).toBe(WINDOW_LINES);
    expect((await svc({ sources: ['no_such_source'] })).universeLineCount).toBe(WINDOW_LINES);
    expect((await svc({ minAmount: 1e9 })).universeLineCount).toBe(WINDOW_LINES);
  });

  it('an empty window has universe 0 (the zero is then true)', async () => {
    const page = await getGeneralLedgerLines({ companyId: company, periodStart: '2026-07-01', periodEnd: '2026-07-02', limit: 10 });
    expect([page.lineCount, page.universeLineCount]).toEqual([0, 0]);
  });

  it('paging to the end keeps the universe on the empty tail page', async () => {
    const first = await svc({ limit: WINDOW_LINES });
    expect(first.lines).toHaveLength(WINDOW_LINES);
    const tail = await svc({ limit: 10, after: first.next });
    expect(tail.lines).toHaveLength(0);
    expect([tail.lineCount, tail.universeLineCount]).toEqual([WINDOW_LINES, WINDOW_LINES]);
  });
});
