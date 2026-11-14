/**
 * `detail: "summary"` / `group_by` on the ledger tools (list_journals, general_ledger, export_gl_lines) against a
 * real database: for the same filters, the summary's totals equal the sum of the rows the tool pages out, and its
 * groups add up to those totals. Company B's ledger (SECRET) must never be counted.
 *
 * Seed: the GL dimension fixture (helpers/glDimensionFixture.ts) plus extra journals on other sources and months so
 * every group_by has more than one group. Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropGlDimensionFixture, seedGlDimensionFixture, type GlDimFixture } from './helpers/glDimensionFixture';
import { listJournalsTool } from '@/lib/mcp/tools/journals';
import { generalLedgerTool } from '@/lib/mcp/tools/generalLedger';
import { exportGlLinesTool } from '@/lib/mcp/tools/exportGlLines';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
const cents = (n: number): number => Math.round(n * 100) / 100;
const sum = (xs: number[]): number => cents(xs.reduce((a, b) => a + b, 0));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Group { key: string; label: string | null; [m: string]: number | string | null }

describeIfDisposable('MCP ledger summaries against a real ledger', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let f: GlDimFixture;
  let ctx: McpToolContext;
  const extraEntries: string[] = [];

  async function call(tool: McpTool, args: Record<string, unknown>): Promise<Json> {
    const res = await tool.handler(args, ctx);
    if (res.isError) throw new Error(`${tool.name}: ${res.content[0]!.text}`);
    return JSON.parse(res.content[0]!.text) as Json;
  }

  beforeAll(async () => {
    f = await seedGlDimensionFixture(pool, `sum-${Date.now()}`);
    ctx = { userId: f.user, companyId: f.a, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null };
    // More sources and months: an invoice posting in March, a bank allocation in April, a payroll one in May.
    for (const [src, date, dr] of [['auto_invoice', '2025-03-10', 250], ['auto_bank_recon', '2025-04-12', 80.5], ['auto_payroll', '2025-05-20', 1234.56]] as const) {
      const eid = crypto.randomUUID();
      extraEntries.push(eid);
      await pool.query(
        `INSERT INTO gl_journal_entries(id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
         VALUES ($1,$2,$3,$4::DATE,'posted',$5,'sum extra',$6, NOW())`,
        [eid, f.a, `SUMX-${src}-${Date.now()}`, date, f.user, src]);
      await pool.query(
        `INSERT INTO gl_journal_lines(journal_entry_id, company_id, gl_account_id, debit, credit, description)
         VALUES ($1,$2,$3,$4,0,'x'), ($1,$2,$5,0,$4,'x')`, [eid, f.a, f.acc.opex, dr, f.acc.bank]);
    }
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = ANY($1::UUID[])', [extraEntries]);
    await pool.query('DELETE FROM gl_journal_entries WHERE id = ANY($1::UUID[])', [extraEntries]);
    await dropGlDimensionFixture(pool, f);
    await pool.end();
  });

  const groupsAddUp = (body: Json, measures: string[]): void => {
    const groups = body.groups as Group[];
    expect(body.groups_returned).toBe(groups.length);
    expect(body.other).toBeNull();
    for (const m of measures) {
      expect(sum(groups.map((g) => Number(g[m])))).toBe(cents(Number(body.totals[m])));
    }
  };

  describe('list_journals', () => {
    const FILTERS: Array<Record<string, unknown>> = [
      {}, { status: 'posted' }, { status: 'reversed' }, { status: 'draft' }, { source: 'manual' }, { source: 'auto_payroll' },
      { from_date: '2025-04-01', to_date: '2025-04-30' }, { account_id: undefined },
    ];

    async function pageAll(args: Record<string, unknown>): Promise<Json[]> {
      const out: Json[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const body: Json = await call(listJournalsTool, { ...args, limit: 7, ...(cursor ? { cursor } : {}) });
        out.push(...(body.journals as Json[]));
        cursor = body.next_cursor as string | null;
        if (cursor === null) return out;
      }
      throw new Error('paging did not terminate');
    }
    const keyOf = (j: Json, by: string): string =>
      by === 'source' ? String(j.source) : by === 'month' ? String(j.entryDate).slice(0, 7) : j.reversed ? 'reversed' : String(j.status);

    for (const raw of FILTERS) {
      const label = JSON.stringify(raw);
      it(`totals equal the paged rows, groups equal the rows grouped, for ${label}`, async () => {
        const args = { ...raw, ...(raw.account_id === undefined && 'account_id' in raw ? { account_id: f.acc.bank } : {}) };
        const rows = await pageAll(args);
        const totals = (await call(listJournalsTool, { ...args, detail: 'summary' })).totals;
        expect(totals.count).toBe(rows.length);
        expect(totals.total_debit).toBe(sum(rows.map((j) => Number(j.amount))));
        for (const by of ['source', 'month', 'status'] as const) {
          const body = await call(listJournalsTool, { ...args, group_by: by });
          expect(body.totals).toEqual(totals);
          groupsAddUp(body, ['count', 'total_debit']);
          const expected = new Map<string, { count: number; total_debit: number }>();
          for (const j of rows) {
            const e = expected.get(keyOf(j, by)) ?? { count: 0, total_debit: 0 };
            e.count += 1; e.total_debit = cents(e.total_debit + Number(j.amount));
            expected.set(keyOf(j, by), e);
          }
          const got = new Map((body.groups as Group[]).map((g) => [g.key, { count: g.count, total_debit: g.total_debit }]));
          expect(got).toEqual(expected);
        }
      });
    }

    it('counts company A only: B\'s journals are in no group', async () => {
      const body = await call(listJournalsTool, { group_by: 'source' });
      expect(JSON.stringify(body)).not.toContain('SECRET');
      const direct = await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = $1', [f.a]);
      expect(body.totals.count).toBe(direct.rows[0].n);
    });

    it('a default call is unchanged: journals and next_cursor, nothing else', async () => {
      const body = await call(listJournalsTool, { limit: 3 });
      expect(Object.keys(body).sort()).toEqual(['journals', 'next_cursor']);
      expect(body.journals).toHaveLength(3);
    });
  });

  describe('general_ledger', () => {
    const WINDOW = { period_start: '2025-03-01', period_end: '2025-05-31' };
    const FILTERS: Array<Record<string, unknown>> = [
      {}, { account_codes: ['1000', '6000'] }, { account_types: ['expense'] }, { sources: ['manual'] }, { sources: ['auto_payroll', 'auto_invoice'] },
      { min_amount: 100 }, { search: 'sum extra' },
    ];

    async function pageAll(args: Record<string, unknown>): Promise<Json[]> {
      const out: Json[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const body: Json = await call(generalLedgerTool, { ...WINDOW, ...args, limit: 9, ...(cursor ? { cursor } : {}) });
        out.push(...(body.rows as Json[]));
        cursor = body.next_cursor as string | null;
        if (cursor === null) return out;
      }
      throw new Error('paging did not terminate');
    }

    for (const raw of FILTERS) {
      it(`group totals equal the paged lines and the call's own totals, for ${JSON.stringify(raw)}`, async () => {
        const rows = await pageAll(raw);
        for (const by of ['account', 'month', 'source', 'account_type'] as const) {
          const body = await call(generalLedgerTool, { ...WINDOW, ...raw, group_by: by });
          expect(body.detail).toBe('summary');
          expect(body.rows).toEqual([]);
          expect(body.totalDebit).toBe(sum(rows.map((r) => Number(r.debit))));
          expect(body.totalCredit).toBe(sum(rows.map((r) => Number(r.credit))));
          expect(body.rowsTotal).toBe(rows.length);
          const groups = body.groups as Group[];
          expect(sum(groups.map((g) => Number(g.total_debit)))).toBe(body.totalDebit);
          expect(sum(groups.map((g) => Number(g.total_credit)))).toBe(body.totalCredit);
          expect(groups.reduce((n, g) => n + Number(g.line_count), 0)).toBe(rows.length);
          const keyOf = (r: Json): string => by === 'account' ? r.accountCode : by === 'month' ? String(r.date).slice(0, 7) : by === 'source' ? r.source : r.accountType;
          const expected = new Map<string, number>();
          for (const r of rows) expected.set(keyOf(r), (expected.get(keyOf(r)) ?? 0) + 1);
          expect(new Map(groups.map((g) => [g.key, g.line_count]))).toEqual(expected);
        }
      });
    }

    it('names the account on an account group and ignores B', async () => {
      const body = await call(generalLedgerTool, { ...WINDOW, group_by: 'account' });
      expect((body.groups as Group[]).find((g) => g.key === '6000')?.label).toBe('Opex');
      expect(JSON.stringify(body)).not.toContain('SECRET');
    });

    it('detail summary without group_by is the old summary: no groups', async () => {
      const body = await call(generalLedgerTool, { ...WINDOW, detail: 'summary' });
      expect(body).not.toHaveProperty('groups');
      expect(body.rowsTotal).toBeGreaterThan(0);
    });
  });

  describe('export_gl_lines', () => {
    const WINDOWS: Array<Record<string, unknown>> = [
      {}, { status: 'posted' }, { date_from: '2025-04-01', date_to: '2025-04-30' }, { date_from: '2025-04-01', date_to: '2025-04-30', status: 'posted' },
    ];

    async function pageAll(args: Record<string, unknown>): Promise<{ cols: string[]; rows: unknown[][] }> {
      const rows: unknown[][] = [];
      let cursor: string | null = null;
      let cols: string[] = [];
      for (let i = 0; i < 200; i++) {
        const body: Json = await call(exportGlLinesTool, { ...args, limit: 11, ...(cursor ? { cursor } : {}) });
        cols = body.columns as string[];
        rows.push(...(body.rows as unknown[][]));
        cursor = body.next_cursor as string | null;
        if (cursor === null) return { cols, rows };
      }
      throw new Error('paging did not terminate');
    }

    for (const raw of WINDOWS) {
      it(`groups add up to the window's summary and to the paged rows, for ${JSON.stringify(raw)}`, async () => {
        const { cols, rows } = await pageAll(raw);
        const at = (r: unknown[], c: string): unknown => r[cols.indexOf(c)];
        const first = await call(exportGlLinesTool, { ...raw, detail: 'summary' });
        expect(first.summary.rowCount).toBe(rows.length);
        const net = sum(rows.map((r) => Number(at(r, 'Amount_Excl_VAT'))));
        for (const by of ['account', 'month', 'source', 'status'] as const) {
          const body = await call(exportGlLinesTool, { ...raw, group_by: by });
          expect(body.summary).toEqual(first.summary);
          const groups = body.groups as Group[];
          expect(groups.reduce((n, g) => n + Number(g.line_count), 0)).toBe(first.summary.rowCount);
          expect(sum(groups.map((g) => Number(g.net)))).toBe(net);
          expect(sum(groups.map((g) => Number(g.total_debit))) - sum(groups.map((g) => Number(g.total_credit)))).toBeCloseTo(net, 2);
          const keyOf = (r: unknown[]): string => by === 'account' ? String(at(r, 'GL_Account_Code') ?? '')
            : by === 'month' ? String(at(r, 'Txn_Date')).slice(0, 7) : by === 'source' ? String(at(r, 'Journal_Source') ?? '')
              : String(at(r, 'Posting_Status')).toLowerCase();
          const expected = new Map<string, number>();
          for (const r of rows) expected.set(keyOf(r), (expected.get(keyOf(r)) ?? 0) + 1);
          expect(new Map(groups.map((g) => [g.key, g.line_count]))).toEqual(expected);
        }
      });
    }

    it('group_by on another table is refused; a default page is unchanged', async () => {
      const res = await exportGlLinesTool.handler({ table: 'accounts', group_by: 'month' }, ctx);
      expect(res.isError).toBe(true);
      const body = await call(exportGlLinesTool, { limit: 5 });
      expect(body).not.toHaveProperty('groups');
      expect(body.rows).toHaveLength(5);
    });
  });
});
