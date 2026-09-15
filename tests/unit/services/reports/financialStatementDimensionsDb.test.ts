import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet, getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: async () => ({ accountCode: '3100' }),
}));
import incomeCsv from '../../../../pages/api/accounting/income-statement-export';
import balanceCsv from '../../../../pages/api/accounting/balance-sheet-export';
import incomeXlsx from '../../../../pages/api/accounting/income-statement-xlsx';
import balanceXlsx from '../../../../pages/api/accounting/balance-sheet-xlsx';

const company = '10000000-0000-4000-8000-000000000001';
const foreign = '10000000-0000-4000-8000-000000000002';
const legacy = '30000000-0000-4000-8000-000000000001';
const cc1 = '30000000-0000-4000-8000-000000000002';
const cc2 = '30000000-0000-4000-8000-000000000003';
const project = '30000000-0000-4000-8000-000000000004';
const selectedBu = '60000000-0000-4000-8000-000000000001';
const otherBu = '60000000-0000-4000-8000-000000000002';
const priorRevenue = '50000000-0000-4000-8000-000000000005';
const accountIds = {
  asset: '50000000-0000-4000-8000-000000000001',
  revenue: '50000000-0000-4000-8000-000000000002',
  equity: '50000000-0000-4000-8000-000000000003',
  liability: '50000000-0000-4000-8000-000000000004',
};

// All report/export SQL executes against connection-local tables, rolled back.
// Only middleware and the retained-earnings account label are mocked.
async function withLedger(run: () => Promise<void>) {
  assertNotProductionDb('Temporary-table financial statement regression');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
      await sql`CREATE TEMP TABLE IF NOT EXISTS companies (id uuid, name text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_accounts (id uuid, company_id uuid, account_code text, account_name text,
        account_type text, account_subtype text, normal_balance text, level int, parent_account_id uuid) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_entries (id uuid, company_id uuid, status text, entry_date date) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_lines (company_id uuid, journal_entry_id uuid, gl_account_id uuid,
        debit numeric, credit numeric, cost_center_id uuid, cc1_id uuid, cc2_id uuid, project_id uuid, bu_id uuid) ON COMMIT DROP`;
      await sql`INSERT INTO companies VALUES (${company}::uuid, 'Fixture')`;
      for (const [type, code] of [['asset', '1100'], ['revenue', '4000'], ['equity', '3000'], ['liability', '2000']] as const) {
        await sql`INSERT INTO gl_accounts VALUES (${accountIds[type]}::uuid, ${company}::uuid, ${code}, ${type},
          ${type}, ${type}, ${type === 'asset' ? 'debit' : 'credit'}, 3, NULL)`;
      }
      for (const [n, date, amount, type, dimension, owner, status] of [
        [1, '2026-04-04', 17, 'revenue', 'explicit', company, 'posted'],
        [2, '2026-02-04', 11, 'revenue', 'explicit', company, 'posted'],
        [3, '2026-04-04', 100, 'revenue', 'none', company, 'posted'],
        [4, '2026-04-04', 999, 'revenue', 'explicit', foreign, 'posted'],
        [5, '2026-04-04', 3, 'revenue', 'legacy', company, 'posted'],
        [6, '2026-04-04', 5, 'equity', 'explicit', company, 'posted'],
        [7, '2026-04-04', 7, 'liability', 'explicit', company, 'posted'],
        [8, '2026-04-04', 888, 'revenue', 'explicit', company, 'draft'],
        [9, '2026-05-04', 777, 'revenue', 'explicit', company, 'posted'],
      ] as const) {
        const id = `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await sql`INSERT INTO gl_journal_entries VALUES (${id}::uuid, ${owner}::uuid, ${status}, ${date}::date)`;
        const buId = n === 3 ? otherBu : selectedBu;
        for (const side of ['asset', type] as const) {
          await sql`INSERT INTO gl_journal_lines VALUES (${owner}::uuid, ${id}::uuid, ${accountIds[side]}::uuid,
            ${side === 'asset' ? amount : 0}, ${side === 'asset' ? 0 : amount},
            ${dimension === 'none' ? null : legacy}::uuid, ${dimension === 'explicit' ? cc1 : null}::uuid,
            ${dimension === 'explicit' ? cc2 : null}::uuid, ${project}::uuid, ${buId}::uuid)`;
        }
      }
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

describe('financial statement dimensions (Postgres)', async () => {
  const reachable = await isDbReachable();
  it.skipIf(!reachable)('includes explicit and independent legacy attribution in current and prior income', async () => {
    await withLedger(async () => {
      for (const [selected, expected] of [[cc2, 17], [cc1, 17], [legacy, 20], [undefined, 120]] as const) {
        const report = await getIncomeStatement(company, '2026-04-01', '2026-04-30',
          { costCentreId: selected, projectId: project }, { start: '2026-02-01', end: '2026-02-28' });
        expect(report.netProfit, selected).toBe(expected);
        expect(report.priorNetProfit).toBe(11);
        expect(report.revenue[0]).toMatchObject({ amount: expected, priorAmount: 11 });
      }
      expect((await getIncomeStatement(company, '2026-04-01', '2026-04-30',
        { costCentreId: cc2, projectId: foreign })).netProfit).toBe(0);
    });
  });
  it.skipIf(!reachable)('combines canonical BU and independent cost-centre attribution with AND', async () => {
    await withLedger(async () => {
      const byBu = await getIncomeStatement(company, '2026-04-01', '2026-04-30',
        { businessUnitId: selectedBu, projectId: project }, { start: '2026-02-01', end: '2026-02-28' });
      expect(byBu).toMatchObject({ netProfit: 20, priorNetProfit: 11, businessUnitId: selectedBu });
      expect(byBu.revenue[0]).toMatchObject({ amount: 20, priorAmount: 11 });

      expect((await getIncomeStatement(company, '2026-04-01', '2026-04-30',
        { businessUnitId: selectedBu, costCentreId: cc2, projectId: project })).netProfit).toBe(17);
      expect((await getIncomeStatement(company, '2026-04-01', '2026-04-30',
        { businessUnitId: selectedBu, costCentreId: legacy, projectId: project })).netProfit).toBe(20);
      expect((await getIncomeStatement(company, '2026-04-01', '2026-04-30',
        { businessUnitId: otherBu, costCentreId: cc2, projectId: project })).netProfit).toBe(0);
    });
  });
  it.skipIf(!reachable)('keeps prior-only BU accounts in comparative rows', async () => {
    await withLedger(async () => {
      const entry = '40000000-0000-4000-8000-000000000010';
      await sql`INSERT INTO gl_accounts VALUES (${priorRevenue}::uuid, ${company}::uuid, '4100', 'Prior-only Sales',
        'revenue', 'revenue', 'credit', 3, NULL)`;
      await sql`INSERT INTO gl_journal_entries VALUES (${entry}::uuid, ${company}::uuid, 'posted', '2026-02-05'::date)`;
      await sql`INSERT INTO gl_journal_lines VALUES (${company}::uuid, ${entry}::uuid, ${accountIds.asset}::uuid,
        13, 0, ${legacy}::uuid, ${cc1}::uuid, ${cc2}::uuid, ${project}::uuid, ${selectedBu}::uuid)`;
      await sql`INSERT INTO gl_journal_lines VALUES (${company}::uuid, ${entry}::uuid, ${priorRevenue}::uuid,
        0, 13, ${legacy}::uuid, ${cc1}::uuid, ${cc2}::uuid, ${project}::uuid, ${selectedBu}::uuid)`;

      const report = await getIncomeStatement(company, '2026-04-01', '2026-04-30',
        { businessUnitId: selectedBu, costCentreId: cc2, projectId: project },
        { start: '2026-02-01', end: '2026-02-28' });
      expect(report.priorTotalRevenue).toBe(24);
      expect(report.revenue.find(line => line.accountCode === '4100'))
        .toMatchObject({amount:0, priorAmount:13, variance:-13});
      expect(report.revenue.reduce((sum, line) => sum + (line.priorAmount ?? 0), 0)).toBe(24);
    });
  });
  it.skipIf(!reachable)('keeps current/prior balances, retained earnings and posted equity on the same centre', async () => {
    await withLedger(async () => {
      for (const [selected, profit] of [[cc2, 28], [cc1, 28], [legacy, 31], [undefined, 131]] as const) {
        const report = await getBalanceSheet(company, '2026-04-30', selected, '2026-02-28');
        expect(report.totalAssets, selected).toBe(profit + 12);
        expect(report.totalLiabilities).toBe(7);
        expect(report.totalEquity).toBe(profit + 5);
        expect(report.equity.find(r => r.accountCode === '3100')).toMatchObject({ balance: profit, priorBalance: 11 });
        expect(report).toMatchObject({ priorTotalAssets: 11, priorTotalLiabilities: 0, priorTotalEquity: 11 });
        expect(await getEquityBases(company, '2026-04-30', selected)).toEqual({ posted: 5, derivedRetainedEarnings: profit });
      }
    });
  });
  it.skipIf(!reachable)('filters every balance-sheet basis by canonical BU and combines centre with AND', async () => {
    await withLedger(async () => {
      for (const [n, date, amount, type] of [
        [12, '2026-02-06', 90, 'revenue'],
        [13, '2026-04-06', 40, 'equity'],
      ] as const) {
        const entry = `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await sql`INSERT INTO gl_journal_entries VALUES (${entry}::uuid, ${company}::uuid, 'posted', ${date}::date)`;
        for (const side of ['asset', type] as const) {
          await sql`INSERT INTO gl_journal_lines VALUES (${company}::uuid, ${entry}::uuid, ${accountIds[side]}::uuid,
            ${side === 'asset' ? amount : 0}, ${side === 'asset' ? 0 : amount},
            ${legacy}::uuid, ${cc1}::uuid, ${cc2}::uuid, ${project}::uuid, ${otherBu}::uuid)`;
        }
      }
      const byBu = await getBalanceSheet(company, '2026-04-30', undefined, '2026-02-28', selectedBu);
      expect(byBu).toMatchObject({
        businessUnitId: selectedBu,
        totalAssets: 43, totalLiabilities: 7, totalEquity: 36,
        priorTotalAssets: 11, priorTotalLiabilities: 0, priorTotalEquity: 11,
      });
      expect(byBu.equity.find(r => r.accountCode === '3100'))
        .toMatchObject({balance:31, priorBalance:11});
      expect(await getEquityBases(company, '2026-04-30', undefined, selectedBu))
        .toEqual({posted:5, derivedRetainedEarnings:31});

      const byBoth = await getBalanceSheet(company, '2026-04-30', cc2, undefined, selectedBu);
      expect(byBoth).toMatchObject({totalAssets:40, totalLiabilities:7, totalEquity:33});
      expect(await getEquityBases(company, '2026-04-30', cc2, selectedBu))
        .toEqual({posted:5, derivedRetainedEarnings:28});
      expect((await getBalanceSheet(company, '2026-04-30', foreign, undefined, otherBu)).totalAssets).toBe(0);
    });
  });
  it.skipIf(!reachable)('keeps prior-only BU balance accounts in comparative rows', async () => {
    await withLedger(async () => {
      const priorAsset = '50000000-0000-4000-8000-000000000006';
      await sql`INSERT INTO gl_accounts VALUES (${priorAsset}::uuid, ${company}::uuid, '1200', 'Prior-only asset',
        'asset', 'asset', 'debit', 3, NULL)`;
      for (const [n, date, debit, credit] of [
        [10, '2026-02-05', 13, 0], [11, '2026-03-05', 0, 13],
      ] as const) {
        const entry = `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await sql`INSERT INTO gl_journal_entries VALUES (${entry}::uuid, ${company}::uuid, 'posted', ${date}::date)`;
        await sql`INSERT INTO gl_journal_lines VALUES (${company}::uuid, ${entry}::uuid, ${priorAsset}::uuid,
          ${debit}, ${credit}, ${legacy}::uuid, ${cc1}::uuid, ${cc2}::uuid, ${project}::uuid, ${selectedBu}::uuid)`;
        await sql`INSERT INTO gl_journal_lines VALUES (${company}::uuid, ${entry}::uuid, ${accountIds.liability}::uuid,
          ${credit}, ${debit}, ${legacy}::uuid, ${cc1}::uuid, ${cc2}::uuid, ${project}::uuid, ${selectedBu}::uuid)`;
      }

      const report = await getBalanceSheet(company, '2026-04-30', cc2, '2026-02-28', selectedBu);
      expect(report.assets.find(line => line.accountCode === '1200'))
        .toMatchObject({balance:0, priorBalance:13, variance:-13});
      expect(report.assets.reduce((sum, line) => sum + (line.priorBalance ?? 0), 0))
        .toBe(report.priorTotalAssets);
    });
  });
  it.skipIf(!reachable)('exports only selected CC2 amounts through both CSV and Excel routes', async () => {
    await withLedger(async () => {
      for (const [handler, kind, format] of [
        [incomeCsv, 'income', 'csv'], [balanceCsv, 'balance', 'csv'],
        [incomeXlsx, 'income', 'xlsx'], [balanceXlsx, 'balance', 'xlsx'],
      ] as const) {
        let body: string | Buffer = '';
        const chunks: Buffer[] = [];
        const res = Object.assign(new Writable({ write(chunk: Buffer, _encoding, done) {
          chunks.push(Buffer.from(chunk)); done();
        } }), { setHeader: vi.fn(), status: () => res,
          send: (v: string | Buffer) => { body = v; }, json: vi.fn() });
        const req = { method: 'GET', companyId: company, query: { cost_centre_id: cc2, business_unit_id: selectedBu,
          period_start: '2026-04-01', period_end: '2026-04-30', as_at_date: '2026-04-30' } } as unknown as NextApiRequest;
        await handler(req as never, res as unknown as NextApiResponse);
        expect(res.json).not.toHaveBeenCalled();
        if (format === 'csv') {
          expect(String(body)).toContain(kind === 'income' ? '"4000","revenue",17.00' : '"1100","asset",40.00');
          if (kind === 'balance') expect(String(body)).toContain('"3100","Retained Earnings (Current)",28.00');
        } else {
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(Buffer.concat(chunks) as unknown as ExcelJS.Buffer);
          const rows: unknown[][] = [];
          wb.worksheets[0]!.eachRow(row => { rows.push(row.values as unknown[]); });
          expect(rows.some(row => row[2] === (kind === 'income' ? '4000' : '1100')
            && row[4] === (kind === 'income' ? 17 : 40))).toBe(true);
        }
      }
    });
  });
});
