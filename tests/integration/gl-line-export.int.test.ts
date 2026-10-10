/**
 * The flat GL-line export against a real database (PR #688 review round 1):
 * the keyset (strict `>` with the line-id tiebreak, ORDER BY incl. line id),
 * the summary's predicate and company scope, the control total over Posted
 * rows only, every join scoped to the company (accounts, cost centres,
 * business units, documents, counterparties, fiscal periods), the
 * deterministic document choice, the paged master tables, read:contacts on
 * counterparties, and FY / FY_Period_No from each company's own year start.
 *
 * Seed and hand-worked figures: helpers/glDimensionFixture.ts. Disposable
 * databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropGlDimensionFixture, seedGlDimensionFixture, type GlDimFixture } from './helpers/glDimensionFixture';
import { toExportRow, type GlLineExportRow } from '@/modules/accounting/services/reports/glLineExportRows';
import {
  fetchGlLineExportPage,
  getExportEntity,
  getGlLineExportSummary,
  nextCursorOf,
  type GlLineExportCursor,
  type GlLineExportOptions,
} from '@/modules/accounting/services/reports/glLineExportService';
import {
  countExportDimensionTable,
  getExportDimensionTablePage,
  type GlDimensionTable,
  type GlTableCursor,
} from '@/modules/accounting/services/reports/glLineExportTables';
import { GlExportScopeRefusal, exportGlLinesTool } from '@/lib/mcp/tools/exportGlLines';
import type { McpToolContext } from '@/lib/mcp/types';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
const APRIL: GlLineExportOptions = { dateFrom: '2025-04-01', dateTo: '2025-04-30' };

describeIfDisposable('flat GL-line export on a real ledger', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let f: GlDimFixture;
  const fiscalCos: string[] = [];

  beforeAll(async () => { f = await seedGlDimensionFixture(pool, `exp-${Date.now()}`); }, 60_000);
  afterAll(async () => {
    await dropGlDimensionFixture(pool, f);
    if (fiscalCos.length > 0) {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1::UUID[])', [fiscalCos]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1::UUID[])', [fiscalCos]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::UUID[])', [fiscalCos]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [fiscalCos]);
    }
    await pool.end();
  });

  /** Every row of the window, paging with `limit`. */
  async function pageAll(company: string, opts: GlLineExportOptions, limit: number): Promise<GlLineExportRow[]> {
    const entity = await getExportEntity(company);
    const out: GlLineExportRow[] = [];
    let cursor: GlLineExportCursor | null = null;
    for (let i = 0; i < 500; i++) {
      const page = await fetchGlLineExportPage(company, opts, cursor, limit);
      out.push(...page.map((r) => toExportRow(r, entity)));
      cursor = nextCursorOf(page, limit);
      if (cursor === null) return out;
    }
    throw new Error('paging did not terminate');
  }
  const byDesc = (rows: GlLineExportRow[], d: string) => rows.filter((r) => r.Line_Description === d);

  it('the summary counts A\'s window only, and its control total is over Posted rows only', async () => {
    expect(await getGlLineExportSummary(f.a, APRIL)).toEqual({
      schemaVersion: 'isaflow-gl-lines-1.0', rowCount: 33, postedRowCount: 29, txnCount: 13,
      controlTotal: 0, unbalancedTxnCount: 0, firstTxnDate: '2025-04-01', lastTxnDate: '2025-04-30',
    });
    expect((await getGlLineExportSummary(f.a, { ...APRIL, status: 'posted' })).rowCount).toBe(29);
  });

  it('paging at every size yields the same lines, once each, in (date, entry, line) order', async () => {
    const whole = await pageAll(f.a, APRIL, 5000);
    expect(whole.length).toBe(33);
    const ids = whole.map((r) => r.Line_ID);
    for (const limit of [1, 2, 3, 4, 5, 7]) {
      expect((await pageAll(f.a, APRIL, limit)).map((r) => r.Line_ID), `limit ${limit}`).toEqual(ids);
    }
    // E12's six lines sit in line-id order whatever order they were written in.
    const e12 = whole.filter((r) => r.Txn_ID === whole.find((x) => x.Line_ID.startsWith('ffffffff'))!.Txn_ID);
    expect(e12.map((r) => r.Line_ID)).toEqual([...e12.map((r) => r.Line_ID)].sort());
    expect((await pageAll(f.a, { ...APRIL, status: 'posted' }, 4)).length).toBe(29);
  });

  it('every join is scoped to A: B\'s account, cost centre, project, BU, supplier and invoice stay blank', async () => {
    const rows = await pageAll(f.a, APRIL, 5000);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows.every((r) => r.Entity === f.aName)).toBe(true);
    const foreignAccount = rows.find((r) => r.Amount_Excl_VAT === -9)!;
    expect([foreignAccount.GL_Account_Code, foreignAccount.GL_Account_Name]).toEqual([null, null]);
    const fin = rows.find((r) => r.GL_Account_Code === '7000')!;
    expect([fin.CC1_Code, fin.BU_Code, fin.Reverses_Txn_ID]).toEqual([null, null, null]);
    expect(rows.find((r) => r.Amount_Excl_VAT === 1 && r.GL_Account_Code === '6000')!.CC2_Code).toBeNull();
    const e09 = rows.find((r) => r.Amount_Excl_VAT === 40)!;
    expect([e09.Document_No, e09.Counterparty_Type, e09.Counterparty_ID, e09.Counterparty_Name])
      .toEqual(['SI-0009', 'Supplier', f.sup.sB, null]);
    const e13 = rows.find((r) => r.Amount_Excl_VAT === -0.03)!;
    expect([e13.Document_No, e13.Counterparty_Type, e13.Counterparty_ID, e13.Counterparty_Name])
      .toEqual(['INV-0013', 'Customer', f.cus.cB, null]);
    const e03 = byDesc(rows, '@SUM(A1)')[0]!;
    expect([e03.Document_No, e03.Linked_Document_Count, e03.Counterparty_Name]).toEqual([null, 0, null]);
  });

  it('documents and counterparties: the documented first, and how many there were', async () => {
    const rows = await pageAll(f.a, APRIL, 5000);
    const e02 = byDesc(rows, '+cmd')[0]!;
    expect([e02.Document_No, e02.Linked_Document_Count, e02.Counterparty_Name]).toEqual(['SI-0002', 1, 'Acme Supplies']);
    expect([e02.CC1_Code, e02.CC2_Code, e02.CC2_Parent_Code, e02.BU_Code]).toEqual(['HT', 'P2', 'HT', 'B2']);
    const e10 = rows.find((r) => r.GL_Account_Code === '4000' && r.Amount_Excl_VAT === 100)!;
    expect([e10.Document_No, e10.Linked_Document_Count, e10.Counterparty_Name]).toEqual(['INV-0010A', 2, 'Jane Private']);
    const e08 = rows.find((r) => r.Line_Description === 'E08' && r.GL_Account_Code === '6000')!;
    expect(e08.Reverses_Txn_ID).toBe(rows.find((r) => r.Posting_Status === 'Reversed')!.Txn_ID);
  });

  it('Period_Locked reads A\'s periods only: April open (B\'s April is locked), March closed', async () => {
    const april = await pageAll(f.a, APRIL, 5000);
    expect(april.every((r) => r.Period_Locked === false)).toBe(true);
    const march = await pageAll(f.a, { dateFrom: '2025-03-01', dateTo: '2025-03-31' }, 5000);
    expect(march.length).toBe(2);
    expect(march.every((r) => r.Period_Locked === true)).toBe(true);
    expect(march[0]!.FY).toBe('FY26');
    expect(april.every((r) => r.FY === 'FY26' && r.FY_Period_No === 2)).toBe(true);
  });

  it('master tables page to exhaustion over A\'s rows only', async () => {
    const all = async (table: GlDimensionTable, limit: number) => {
      const rows: Array<Record<string, unknown>> = [];
      let cursor: GlTableCursor | null = null;
      for (let i = 0; i < 100; i++) {
        const page = await getExportDimensionTablePage(f.a, table, cursor, limit);
        rows.push(...page.rows);
        cursor = page.next;
        if (cursor === null) return rows;
      }
      throw new Error('paging did not terminate');
    };
    const accounts = await all('accounts', 3);
    expect(accounts.map((r) => r.GL_Account_Code)).toEqual(['1000', '2000', '4000', '4900', '5000', '6000', '6100', '7000']);
    expect(await countExportDimensionTable(f.a, 'accounts')).toBe(8);
    const ccs = await all('cost_centres', 1);
    expect(ccs.map((r) => [r.CC_Level, r.CC_Code, r.Parent_Code])).toEqual([
      ['cc1', 'FT', null], ['cc1', 'HT', null], ['cc2', 'P1', 'FT'], ['cc2', 'P2', 'HT'],
    ]);
    expect((await all('business_units', 1)).map((r) => r.BU_Code)).toEqual(['B1', 'B2']);
    const cps = await all('counterparties', 1);
    expect(cps.map((r) => [r.Counterparty_Type, r.Counterparty_Name])).toEqual([['Customer', 'Jane Private'], ['Supplier', 'Acme Supplies']]);
    expect(await countExportDimensionTable(f.a, 'counterparties')).toBe(2);
    expect(JSON.stringify([accounts, ccs, cps])).not.toContain('SECRET');
  });

  it('export_gl_lines: counterparties need read:contacts; lines carry the summary on page 1 only', async () => {
    const ctx = { userId: f.user, companyId: f.a, scopes: ['read:reports'], tokenJti: null, oauthAppId: null } as McpToolContext;
    await expect(exportGlLinesTool.handler({ table: 'counterparties' }, ctx)).rejects.toBeInstanceOf(GlExportScopeRefusal);
    const withContacts = JSON.parse((await exportGlLinesTool.handler(
      { table: 'counterparties' }, { ...ctx, scopes: ['read:reports', 'read:contacts'] },
    )).content[0]!.text) as { rows: unknown[][]; row_count: number };
    expect(withContacts.row_count).toBe(2);
    expect(withContacts.rows.map((r) => r[1])).toEqual(['Jane Private', 'Acme Supplies']);

    const seen: string[] = [];
    let cursor: string | null = null;
    let first = true;
    do {
      const body = JSON.parse((await exportGlLinesTool.handler(
        { date_from: '2025-04-01', date_to: '2025-04-30', limit: 10, ...(cursor ? { cursor } : {}) }, ctx,
      )).content[0]!.text) as { rows: unknown[][]; columns: string[]; summary: unknown; rowsTotal: number; next_cursor: string | null };
      expect(body.rowsTotal).toBe(33);
      expect(body.summary === null).toBe(!first);
      first = false;
      seen.push(...body.rows.map((r) => String(r[body.columns.indexOf('Line_ID')])));
      cursor = body.next_cursor;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(33);
    expect(seen.length).toBe(33);
  });

  it('FY and FY_Period_No follow each company\'s financial_year_start (July, January, unset = March)', async () => {
    const make = async (start: number | null, dates: string[]) => {
      const co = crypto.randomUUID();
      fiscalCos.push(co);
      const acct = crypto.randomUUID();
      await pool.query('INSERT INTO companies(id, name, financial_year_start) VALUES ($1, $2, $3)', [co, `GLX FY ${start}`, start]);
      await pool.query(`INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance)
                        VALUES ($1, $2, '6000', 'Opex', 'expense', 'debit')`, [acct, co]);
      for (const d of dates) {
        const e = crypto.randomUUID();
        await pool.query(`INSERT INTO gl_journal_entries(id, company_id, entry_number, entry_date, status, created_by, source)
                          VALUES ($1, $2, $3, $4::DATE, 'draft', $5, 'manual')`, [e, co, `FY-${d}`, d, f.user]);
        await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, company_id, gl_account_id, debit, credit, description)
                          VALUES ($1, $2, $3, 1, 0, $4)`, [e, co, acct, d]);
      }
      const rows = await pageAll(co, {}, 5000);
      return Object.fromEntries(rows.map((r) => [r.Txn_Date, `${r.FY}/${r.FY_Period_No}`]));
    };
    expect(await make(7, ['2025-06-30', '2025-07-01', '2026-01-15'])).toEqual({
      '2025-06-30': 'FY25/12', '2025-07-01': 'FY26/1', '2026-01-15': 'FY26/7',
    });
    expect(await make(1, ['2025-12-31', '2026-01-01'])).toEqual({ '2025-12-31': 'FY25/12', '2026-01-01': 'FY26/1' });
    expect(await make(null, ['2026-02-28', '2026-03-01'])).toEqual({ '2026-02-28': 'FY26/12', '2026-03-01': 'FY27/1' });
  });
});
