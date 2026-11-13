// general_ledger `search` is a LITERAL substring of the entry number or description (MCP, 2026-11-13), as
// list_bank_transactions' description_contains is. The service wrapped the term in %...% and escaped nothing, so "50%"
// matched "500" and "a_b" matched "axb". Fixture, one window 2026-06-10..2026-06-12, one debit and one credit line each:
//   P  'Pay 50% deposit'   Q  'Pay 500 deposit'   U  'ref a_b'   V  'ref axb'   W  'back\slash'   X  'backXslash'
// Entry numbers are 'GLS-<n>', so a search on 'GLS-' reaches every journal.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generalLedgerTool } from '@/lib/mcp/tools/generalLedger';
import type { McpToolContext } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
const [company, user, bank, exp] = [uuid(), uuid(), uuid(), uuid()];
const ctx: McpToolContext = { userId: user, companyId: company, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null };
const DESCRIPTIONS = ['Pay 50% deposit', 'Pay 500 deposit', 'ref a_b', 'ref axb', 'back\\slash', 'backXslash'];

interface Reply {
  rowsTotal: number; universeTotal: number; excludedTotal: number; completenessFault?: string; rows: Array<{ description: string }>;
}
async function search(term: string): Promise<Reply> {
  const res = await generalLedgerTool.handler({ period_start: '2026-06-10', period_end: '2026-06-12', search: term }, ctx);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0]!.text) as Reply;
}
const descriptions = (r: Reply) => [...new Set(r.rows.map((x) => x.description))].sort();

describe('general_ledger search is a literal substring', () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'GLS']);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'GLS1','GLS Bank','asset','bank','debit'),($2,$3,'GLS2','GLS Expense','expense','operating_expense','debit')`,
      [bank, exp, company]);
    for (const [i, desc] of DESCRIPTIONS.entries()) {
      const je = uuid();
      await pool.query(
        `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,source,created_by,posted_at,posted_by)
         VALUES($1,$2,$3,'2026-06-11',$4,'posted','manual',$5,NOW(),$5)`, [je, company, `GLS-${i}`, desc, user]);
      await pool.query(
        `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
         VALUES($1,$2,$3,$4,10,0),($5,$2,$3,$6,0,10)`, [uuid(), company, je, exp, uuid(), bank]);
    }
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      await pool.end();
    }
  });

  it('"50%" matches "50%" and not "500"', async () => {
    const r = await search('50%');
    expect(descriptions(r)).toEqual(['Pay 50% deposit']);
    expect(r.rowsTotal).toBe(2);
  });

  it('"a_b" matches "a_b" and not "axb"', async () => {
    const r = await search('a_b');
    expect(descriptions(r)).toEqual(['ref a_b']);
    expect(r.rowsTotal).toBe(2);
  });

  it('a backslash is literal too', async () => {
    expect(descriptions(await search('back\\slash'))).toEqual(['back\\slash']);
  });

  it('a lone wildcard matches nothing that lacks it, and the universe still counts the whole window', async () => {
    const pct = await search('%');
    expect(descriptions(pct)).toEqual(['Pay 50% deposit']);
    const none = await search('zz_');
    expect([none.rowsTotal, none.universeTotal, none.excludedTotal, none.completenessFault]).toEqual([0, 12, 12, undefined]);
    const hit = await search('50%');
    expect([hit.universeTotal, hit.excludedTotal]).toEqual([12, 10]);
  });

  it('still matches case-insensitively, on the entry number or the description', async () => {
    expect(descriptions(await search('PAY 50%'))).toEqual(['Pay 50% deposit']);
    expect((await search('gls-3')).rowsTotal).toBe(2);
  });
});
