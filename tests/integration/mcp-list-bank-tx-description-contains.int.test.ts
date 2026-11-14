// list_bank_transactions `description_contains` (MCP, 2026-11-13). The service's account-only branch (bank_account_id,
// no status) ignored `search` in BOTH its rows and its count query, so the filter silently returned every line of the
// account. Proven through the tool against real Postgres, in every argument combination an agent uses:
//   A  2026-06-01  'MAKRO 100% SALE'      B  2026-06-02  'makro 100X SALE'   C  2026-06-03  'Woolworths'
//   D  2026-06-04  NULL description, reference 'MAKRO-REF'                      E  other bank account, 'MAKRO ELSEWHERE'
//   F  other company, 'MAKRO OTHER CO'
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { listBankTransactionsTool } from '@/lib/mcp/tools/bank';
import type { McpToolContext } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
const [company, other, bank, bank2, bankO] = [uuid(), uuid(), uuid(), uuid(), uuid()];
const ids = { A: uuid(), B: uuid(), C: uuid(), D: uuid(), E: uuid(), F: uuid() };
const ctx: McpToolContext = { userId: uuid(), companyId: company, scopes: ['read:bank-tx'], tokenJti: 'j', oauthAppId: null };

interface Reply { transactions: Array<{ id: string }>; total: number; next_cursor: string | null }
async function list(args: Record<string, unknown>): Promise<Reply> {
  const res = await listBankTransactionsTool.handler({ fields: 'compact', ...args }, ctx);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0]!.text) as Reply;
}
const idsOf = (r: Reply) => r.transactions.map((t) => t.id).sort();
const want = (...k: Array<keyof typeof ids>) => k.map((x) => ids[x]).sort();

describe('list_bank_transactions description_contains', () => {
  beforeAll(async () => {
    for (const [co, name] of [[company, 'DC A'], [other, 'DC B']]) await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$4,'DC1','DC Bank 1','asset','bank','debit'),($2,$4,'DC2','DC Bank 2','asset','bank','debit'),($3,$5,'DC1','DC Bank O','asset','bank','debit')`,
      [bank, bank2, bankO, company, other]);
    const rows: Array<[string, string, string, string, string | null, string | null]> = [
      [ids.A, company, bank, '2026-06-01', 'MAKRO 100% SALE', null],
      [ids.B, company, bank, '2026-06-02', 'makro 100X SALE', null],
      [ids.C, company, bank, '2026-06-03', 'Woolworths', null],
      [ids.D, company, bank, '2026-06-04', null, 'MAKRO-REF'],
      [ids.E, company, bank2, '2026-06-05', 'MAKRO ELSEWHERE', null],
      [ids.F, other, bankO, '2026-06-05', 'MAKRO OTHER CO', null],
    ];
    for (const [id, co, acct, date, desc, ref] of rows) {
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,reference,status)
         VALUES($1,$2,$3,$4,-10,$5,$6,'imported')`, [id, co, acct, date, desc, ref]);
    }
  });

  afterAll(async () => {
    try {
      for (const co of [company, other]) {
        await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM companies WHERE id=$1', [co]);
      }
    } finally {
      await pool.end();
    }
  });

  it('company-wide: case-insensitive, matches description or reference, never another company', async () => {
    const r = await list({ description_contains: 'makro' });
    expect(idsOf(r)).toEqual(want('A', 'B', 'D', 'E'));
    expect(r.total).toBe(4);
  });

  it('with bank_account_id (the branch that ignored it): filters rows AND total', async () => {
    const r = await list({ bank_account_id: bank, description_contains: 'makro' });
    expect(idsOf(r)).toEqual(want('A', 'B', 'D'));
    expect(r.total).toBe(3);
  });

  it('is a literal match: % and _ are not wildcards', async () => {
    expect(idsOf(await list({ bank_account_id: bank, description_contains: '100%' }))).toEqual(want('A'));
    expect(idsOf(await list({ description_contains: '100%' }))).toEqual(want('A'));
    expect(idsOf(await list({ bank_account_id: bank, description_contains: 'MAKRO_100' }))).toEqual([]);
    expect(idsOf(await list({ bank_account_id: bank, description_contains: '100_ SALE' }))).toEqual([]);
  });

  it('combines with the date window and allocation_filter', async () => {
    const win = await list({ bank_account_id: bank, description_contains: 'makro', from_date: '2026-06-02', to_date: '2026-06-03' });
    expect(idsOf(win)).toEqual(want('B'));
    expect(win.total).toBe(1);
    const alloc = await list({ bank_account_id: bank, description_contains: 'makro', allocation_filter: 'unallocated' });
    expect(idsOf(alloc)).toEqual(want('A', 'B', 'D'));
    expect((await list({ bank_account_id: bank, description_contains: 'makro', allocation_filter: 'allocated' })).total).toBe(0);
  });

  it('pages by cursor with the filter held: every match once, total the full match count', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const r = await list({ bank_account_id: bank, description_contains: 'makro', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.total).toBe(3);
      seen.push(...r.transactions.map((t) => t.id));
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
    expect(seen.sort()).toEqual(want('A', 'B', 'D'));
  });

  it('without the filter the account lists every line (the filter is what narrows it)', async () => {
    const r = await list({ bank_account_id: bank });
    expect(idsOf(r)).toEqual(want('A', 'B', 'C', 'D'));
    expect(r.total).toBe(4);
  });
});
