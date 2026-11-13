/**
 * `detail: "summary"` / `group_by` on list_bank_transactions against real rows: for the same filters, the summary's
 * totals equal the sum of the rows the tool pages out and its groups (account, month, allocation) equal those rows
 * grouped. Company B's line (SECRET) is never counted, a `removed` feed line is in neither the rows nor the summary,
 * and a named bank account makes the row query ignore description_contains - so the summary must too.
 *
 * Rows: helpers/summaryFixture.ts. Disposable databases only - the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { listBankTransactionsTool } from '@/lib/mcp/tools/bank';
import {
  FX, addUp, callTool, dropSummaryFixture, groupMap, seedSummaryFixture, sum, tally, type Group, type Json,
} from './helpers/summaryFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;

describeIfDisposable('list_bank_transactions summaries against real rows', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const call = (args: Record<string, unknown>): Promise<Json> => callTool(listBankTransactionsTool, args);

  beforeAll(async () => { await seedSummaryFixture(pool); }, 60_000);
  afterAll(async () => { await dropSummaryFixture(pool); await pool.end(); });

  const FILTERS: Array<Record<string, unknown>> = [
    {}, { bank_account_id: FX.acc.a1 }, { bank_account_id: FX.acc.a2, allocation_filter: 'unallocated' }, { allocation_filter: 'allocated' },
    { allocation_filter: 'suggested' }, { allocation_filter: 'unallocated' }, { from_date: '2026-02-01', to_date: '2026-03-31' },
    { description_contains: '50%' }, { description_contains: 'promo' },
    // The row query ignores description_contains when a bank account is named; the summary must follow the rows.
    { bank_account_id: FX.acc.a1, description_contains: 'salary' },
  ];
  async function pageAll(args: Record<string, unknown>, fields: 'full' | 'compact'): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const body: Json = await call( { ...args, fields, limit: 13, ...(cursor ? { cursor } : {}) });
      out.push(...(body.transactions as Json[]));
      cursor = body.next_cursor as string | null;
      if (cursor === null) return out;
    }
    throw new Error('paging did not terminate');
  }

  for (const raw of FILTERS) {
    it(`totals equal the paged rows and groups equal the rows grouped, for ${JSON.stringify(raw)}`, async () => {
      const args = raw;
      const full = await pageAll(args, 'full');
      const compact = new Map((await pageAll(args, 'compact')).map((r) => [r.id as string, r.allocation as string]));
      expect(compact.size).toBe(full.length);
      const totals = (await call( { ...args, detail: 'summary' })).totals;
      const amounts = full.map((r) => Number(r.amount));
      expect(totals).toEqual({
        count: full.length, money_in: sum(amounts.filter((n) => n > 0)), money_out: sum(amounts.filter((n) => n < 0)), net: sum(amounts),
      });
      const measures = { count: () => 1, money_in: (r: Json) => Math.max(Number(r.amount), 0), money_out: (r: Json) => Math.min(Number(r.amount), 0), net: (r: Json) => Number(r.amount) };
      const m = Object.keys(measures);
      for (const [by, keyOf] of [
        ['account', (r: Json) => String(r.bankAccountId)], ['month', (r: Json) => String(r.transactionDate).slice(0, 7)],
        ['allocation', (r: Json) => compact.get(r.id as string)!],
      ] as const) {
        const body = await call( { ...args, group_by: by });
        expect(body.totals).toEqual(totals);
        addUp(body, m);
        expect(groupMap(body, m)).toEqual(tally(full, keyOf, measures));
      }
    });
  }

  it('names the bank account, counts company A only, and skips the removed feed line', async () => {
    const body = await call( { group_by: 'account' });
    expect((body.groups as Group[]).map((g) => g.label).sort()).toEqual(['Main bank', 'Savings']);
    expect(JSON.stringify(body)).not.toContain('SECRET');
    const direct = await pool.query(`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id = $1 AND feed_state <> 'removed'`, [FX.A]);
    expect(body.totals.count).toBe(direct.rows[0].n);
  });

  it('a removed feed line is in no summary, with or without a bank account named', async () => {
    for (const account of [undefined, FX.acc.a1]) {
      const direct = await pool.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS net FROM bank_transactions
         WHERE company_id = $1 AND feed_state <> 'removed' AND ($2::UUID IS NULL OR bank_account_id = $2::UUID)`, [FX.A, account ?? null]);
      const body = await call({ detail: 'summary', ...(account ? { bank_account_id: account } : {}) });
      expect(body.totals.count).toBe(direct.rows[0].n);
      expect(body.totals.net).toBe(direct.rows[0].net);
    }
  });

  it('a default call is unchanged: transactions, total, next_cursor', async () => {
    const body = await call( { limit: 2 });
    expect(Object.keys(body).sort()).toEqual(['next_cursor', 'total', 'transactions']);
  });
});
