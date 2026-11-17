// WP2 row 12, the MCP side (round 2). A bank line dated where no OPEN fiscal period is or can be is refused by
// allocateTransaction as its last check before the journal. Through the registry that refusal would abort a WHOLE
// bulk batch while dry_run called the line postable, and surface as a registry failure on the single tools. Now:
//   • bulk: the line is SKIPPED with the refusal as its reason; dry_run reports the identical skips; the rest posts
//   • allocate / split: a typed toolError (isError, the refusal's own text), nothing written, line still 'imported'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { allocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { splitAllocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankSplit';
import * as periodModule from '../../src/modules/accounting/services/bank/bankAllocationPeriod';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, lineStatus, mcpCaller, plantLine, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const mcp = mcpCaller(pool, [bulkAllocateBankTransactionsTool, allocateBankTransactionTool, splitAllocateBankTransactionTool]);
let seq = 0;
const key = () => `wp2-12-mcp-${Date.now()}-${seq++}`;

interface Skip { index: number; transaction_id: string | null; reason: string }
interface Body { posted: number; would_post?: number; dry_run?: boolean; skipped: Skip[] }
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Body;

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [user]));

async function fixture(): Promise<{ f: BankCompany; open: string; closed: string; far: string }> {
  const f = await bankCompany(pool, [[user, 'admin']], companies);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R12 2025',1,2025,'2025-01-01','2025-12-31','closed')`, [f.c]);
  const open = await plantLine(pool, f, null, -1500);
  const closed = await plantLine(pool, f, null, -700);
  const far = await plantLine(pool, f, null, -300);
  await pool.query("UPDATE bank_transactions SET transaction_date = DATE '2025-06-10' WHERE id = $1", [closed]);
  await pool.query("UPDATE bank_transactions SET transaction_date = DATE '2001-03-15' WHERE id = $1", [far]);
  return { f, open, closed, far };
}
const journals = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const acct = (f: BankCompany, id: string) => ({ transaction_id: id, alloc_type: 'account', contra_account_id: f.expA });

describe('WP2 row 12 through MCP: a line with no open fiscal period', () => {
  it('bulk: skips the closed-period and 2001 lines, posts the open one, dry run identical', async () => {
    const { f, open, closed, far } = await fixture();
    const args = { allocations: [acct(f, open), acct(f, closed), acct(f, far)], idempotency_key: key() };
    const dry = parse(await mcp(user, f.c, 'bulk_allocate_bank_transactions', { ...args, dry_run: true }));
    expect(dry.would_post).toBe(1);
    expect(dry.skipped.map((s) => [s.index, s.transaction_id])).toEqual([[1, closed], [2, far]]);
    expect(dry.skipped[0]!.reason).toMatch(/closed fiscal period/);
    expect(dry.skipped[1]!.reason).toMatch(/^No fiscal period covers 2001-03-15/);
    expect(await journals(f.c)).toBe(0);
    const live = await mcp(user, f.c, 'bulk_allocate_bank_transactions', args);
    expect(live.isError, live.content[0]!.text).toBeFalsy();
    const body = parse(live);
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual(dry.skipped);
    expect(await journals(f.c)).toBe(1);
    expect(await Promise.all([open, closed, far].map((id) => lineStatus(pool, id)))).toEqual(['allocated', 'imported', 'imported']);
    expect((await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND fiscal_period_id IS NULL', [f.c])).rows[0].n).toBe(0);
  });

  it('allocate_bank_transaction: a typed toolError for each, nothing written', async () => {
    const { f, closed, far } = await fixture();
    for (const [id, text] of [[closed, /closed fiscal period/], [far, /^No fiscal period covers 2001-03-15/]] as const) {
      const res = await mcp(user, f.c, 'allocate_bank_transaction', { ...acct(f, id), idempotency_key: key() });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(text);
      expect(await lineStatus(pool, id)).toBe('imported');
    }
    expect(await journals(f.c)).toBe(0);
  });

  it('split_allocate_bank_transaction: a typed toolError for each, dry run and live alike, nothing written', async () => {
    const { f, closed, far } = await fixture();
    for (const [id, amount, text] of [[closed, 700, /closed fiscal period/], [far, 300, /^No fiscal period covers 2001-03-15/]] as const) {
      const lines = [{ contra_account_id: f.expA, amount: amount - 100 }, { contra_account_id: f.expB, amount: 100 }];
      for (const dry of [true, false]) {
        const res = await mcp(user, f.c, 'split_allocate_bank_transaction',
          { transaction_id: id, lines, idempotency_key: key(), ...(dry ? { dry_run: true } : {}) });
        expect(res.isError, `${dry ? 'dry' : 'live'}: ${res.content[0]!.text}`).toBe(true);
        expect(res.content[0]!.text).toMatch(text);
      }
      expect(await lineStatus(pool, id)).toBe('imported');
    }
    expect(await journals(f.c)).toBe(0);
  });
});

describe('WP2 row 12: a bulk batch spanning two periods while a closer holds both', () => {
  it('waits on the period rows in budget, no deadlock, and posts both lines once the closer commits', async () => {
    const { f } = await fixture();
    await pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
      VALUES($1,'R12 2024',1,2024,'2024-01-01','2024-12-31','open')`, [f.c]);
    // Allocator order: the LATER period first. The closer takes them in (fiscal_year, period_number) order.
    const late = await plantLine(pool, f, null, -500);
    const early = await plantLine(pool, f, null, -400);
    await pool.query("UPDATE bank_transactions SET transaction_date = DATE '2024-05-05' WHERE id = $1", [early]);
    const closer = await pool.connect();
    await closer.query('BEGIN');
    await closer.query(`SELECT id FROM fiscal_periods WHERE company_id = $1 AND fiscal_year IN (2024, 2026)
      ORDER BY fiscal_year FOR NO KEY UPDATE`, [f.c]);
    const batch = mcp(user, f.c, 'bulk_allocate_bank_transactions',
      { allocations: [acct(f, late), acct(f, early)], idempotency_key: key() });
    await new Promise((r) => setTimeout(r, 1500));
    await closer.query('COMMIT');
    closer.release();
    const res = await batch;
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const body = parse(res);
    expect(body.posted).toBe(2);
    expect(body.skipped).toEqual([]);
    expect(await journals(f.c)).toBe(2);
  }, 90000);
});

describe('WP2 row 12: a period that closes between the probe and the live post', () => {
  it('skips that line with the refusal text; the rest of the batch posts', async () => {
    const { f, open } = await fixture();
    await pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
      VALUES($1,'R12 2024',1,2024,'2024-01-01','2024-12-31','open')`, [f.c]);
    const racing = await plantLine(pool, f, null, -400);
    await pool.query("UPDATE bank_transactions SET transaction_date = DATE '2024-05-05' WHERE id = $1", [racing]);
    const real = periodModule.periodLineSkips;
    // The closer lands right after the probe (its FOR SHARE is rolled back, so nothing blocks the commit).
    const spy = vi.spyOn(periodModule, 'periodLineSkips').mockImplementation(async (...a) => {
      const out = await real(...a);
      await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND fiscal_year = 2024", [f.c]);
      return out;
    });
    try {
      const res = await mcp(user, f.c, 'bulk_allocate_bank_transactions',
        { allocations: [acct(f, open), acct(f, racing)], idempotency_key: key() });
      expect(res.isError, res.content[0]!.text).toBeFalsy();
      const body = parse(res);
      expect(body.posted).toBe(1);
      expect(body.skipped).toEqual([{ index: 1, transaction_id: racing, reason: expect.stringMatching(/closed fiscal period/) }]);
      expect(await lineStatus(pool, racing)).toBe('imported');
      expect(await lineStatus(pool, open)).toBe('allocated');
      expect(await journals(f.c)).toBe(1);
    } finally { spy.mockRestore(); }
  }, 60000);
});
