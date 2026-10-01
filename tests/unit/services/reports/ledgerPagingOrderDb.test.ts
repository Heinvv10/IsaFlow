/**
 * Round 4 (breaker T1/T1b/T5): every ledger listing orders lines by ONE total order
 * (entry_date, je.created_at, jl.id — the stream's), so paging never loses or repeats a
 * line of a multi-line journal, and the same line carries the same running balance in
 * every listing. Temp tables in a rolled-back transaction; nothing persists.
 */
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';
import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const A = '10000000-0000-4000-8000-0000000000e1';
const EXP = '50000000-0000-4000-8000-0000000000e4';
const BANK = '50000000-0000-4000-8000-0000000000e1';
type J = { id: string; date: string; created: string; lines: Array<[string, number, number]> };
let jn = 0;
const j = (date: string, lines: Array<[string, number, number]>, created = `${date}T10:00:00Z`, id?: string): J => {
  jn += 1;
  return { id: id ?? `40000000-0000-4000-8000-${String(jn).padStart(12, '0')}`, date, created, lines };
};

async function withData(journals: J[], run: () => Promise<void>) {
  assertNotProductionDb('ledger paging order');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: A, userId: '', claims: {} }, async () => {
      await sql`CREATE TEMP TABLE companies (id uuid, financial_year_start int) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE fiscal_periods (id uuid, company_id uuid, start_date date, end_date date) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_accounts (id uuid, company_id uuid, account_code text, account_name text,
        account_type text, normal_balance text, account_subtype text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_journal_entries (id uuid, company_id uuid, status text, entry_date date,
        entry_number text, description text, reference text, source text, created_at timestamptz) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_journal_lines (id uuid DEFAULT gen_random_uuid(), company_id uuid,
        journal_entry_id uuid, gl_account_id uuid, debit numeric(15,2), credit numeric(15,2), cost_center_id uuid,
        cc1_id uuid, cc2_id uuid, bu_id uuid, project_id uuid) ON COMMIT DROP`;
      await sql`INSERT INTO companies VALUES (${A}::uuid, 3)`;
      await sql`INSERT INTO gl_accounts VALUES (${BANK}::uuid, ${A}::uuid, '1100', 'Bank', 'asset', 'debit', NULL),
        (${EXP}::uuid, ${A}::uuid, '5000', 'Exp', 'expense', 'debit', NULL)`;
      for (const e of journals) {
        await sql`INSERT INTO gl_journal_entries VALUES (${e.id}::uuid, ${A}::uuid, 'posted', ${e.date}::date,
          ${e.id.slice(-4)}, 'Fixture', '', 'manual', ${e.created}::timestamptz)`;
        for (const [acct, d, c] of e.lines) {
          await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
            VALUES (${A}::uuid, ${e.id}::uuid, ${acct}::uuid, ${d}, ${c})`;
        }
      }
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

const q = { companyId: A, accountCode: '5000', fromDate: '2026-03-01', toDate: '2026-09-30' };
const r2 = (n: number) => Math.round(n * 100) / 100;

describe('ledger paging and ordering (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('T1: paging a multi-line journal serves every line once, at every page size', async () => {
    const lines: Array<[string, number, number]> = [];
    let sum = 0;
    for (let i = 0; i < 150; i += 1) { const v = i + 1 + (i % 7) / 100; lines.push([EXP, v, 0]); sum += v; }
    lines.push([BANK, 0, r2(sum)]);
    await withData([j('2026-04-10', lines), j('2026-05-02', [[EXP, 5, 0], [BANK, 0, 5]])], async () => {
      const full = await getAccountLedger({ ...q, limit: 500 });
      for (const size of [1, 2, 7, 50]) {
        const got: typeof full.rows = [];
        for (let off = 0; off < full.total; off += size) got.push(...(await getAccountLedger({ ...q, limit: size, offset: off })).rows);
        expect(got.map(r => [r.debit, r.runningBalance]), `size ${size}`).toEqual(full.rows.map(r => [r.debit, r.runningBalance]));
        expect(got[got.length - 1]!.runningBalance).toBe(full.periodClosingBalance);
      }
    });
  }, 120000);

  it.skipIf(!reachable)('T1b: at page size 200 a 60-line journal across the edge keeps the page-to-page chain', async () => {
    const js: J[] = [];
    for (let i = 0; i < 180; i += 1) js.push(j(`2026-04-${String(1 + (i % 28)).padStart(2, '0')}`, [[EXP, 1000 + i, 0], [BANK, 0, 1000 + i]]));
    const big: Array<[string, number, number]> = [];
    let sum = 0;
    for (let i = 0; i < 60; i += 1) { big.push([EXP, 0.01 * (i + 1), 0]); sum += 0.01 * (i + 1); }
    big.push([BANK, 0, r2(sum)]);
    js.push(j('2026-05-15', big));
    for (let i = 0; i < 180; i += 1) js.push(j(`2026-06-${String(1 + (i % 28)).padStart(2, '0')}`, [[EXP, 5000 + i, 0], [BANK, 0, 5000 + i]]));
    await withData(js, async () => {
      const pages = [];
      for (let off = 0; off < 420; off += 200) pages.push(await getAccountLedger({ ...q, limit: 200, offset: off }));
      const got = pages.flatMap(p => p.rows);
      expect(got.length).toBe(pages[0]!.total);
      expect(r2(got.reduce((s, r) => s + r.debit - r.credit, 0))).toBe(pages[0]!.periodNet);
      pages.slice(1).forEach((p, i) => {
        const f = p.rows[0]!;
        expect(r2(f.runningBalance - f.debit + f.credit)).toBe(pages[i]!.rows[pages[i]!.rows.length - 1]!.runningBalance);
      });
      expect(got[got.length - 1]!.runningBalance).toBe(pages[0]!.periodClosingBalance);
    });
  }, 120000);

  it.skipIf(!reachable)('T5: same-date journals and multi-line journals: one order and one balance per line in every listing', async () => {
    const first = j('2026-04-10', [[EXP, 100, 0], [EXP, 3, 0], [BANK, 0, 103]], '2026-04-10T08:00:00Z', 'ffffffff-0000-4000-8000-000000000001');
    const second = j('2026-04-10', [[EXP, 7, 0], [BANK, 0, 7]], '2026-04-10T09:00:00Z', '00000000-0000-4000-8000-000000000002');
    await withData([first, second], async () => {
      const ledger = await getAccountLedger({ ...q, fromDate: '2026-04-01', toDate: '2026-04-30', limit: 500 });
      const seq = (rows: Array<{ d: number; b: number }>) => rows.map(r => [r.d, r.b]);
      const a = seq(ledger.rows.map(r => ({ d: r.debit, b: r.runningBalance })));
      const inline = await getAccountTransactions(A, '5000', '2026-04-01', '2026-04-30');
      const report = (await getGeneralLedgerReport(A, '2026-04-01', '2026-04-30')).find(x => x.accountCode === '5000')!;
      const stream = await getGeneralLedgerLines({ companyId: A, periodStart: '2026-04-01', periodEnd: '2026-04-30', accountCodes: ['5000'], limit: 100 });
      expect(a.map(x => x[0]!).sort((x, y) => x - y)).toEqual([3, 7, 100]);
      // the earlier-created journal first; both of its lines together
      expect(a.map(x => x[0]).slice(0, 2).sort((x, y) => x! - y!)).toEqual([3, 100]);
      expect(seq(inline.transactions.map(r => ({ d: r.debit, b: r.balance })))).toEqual(a);
      expect(seq(report.transactions.map(r => ({ d: r.debit, b: r.balance })))).toEqual(a);
      expect(seq(stream.lines.map(r => ({ d: r.debit, b: r.runningBalance as number })))).toEqual(a);
    });
  }, 60000);
});
