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
import { getBankTransactions } from '@/modules/accounting/services/gl/transactionLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';
import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const A = '10000000-0000-4000-8000-0000000000e1';
const EXP = '50000000-0000-4000-8000-0000000000e4';
const BANK = '50000000-0000-4000-8000-0000000000e1';
type J = { id: string; date: string; created: string | null; lines: Array<[string, number, number]> };
let jn = 0;
const j = (date: string, lines: Array<[string, number, number]>, created: string | null = `${date}T10:00:00Z`, id?: string): J => {
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

  // Round 5: every money figure leaves each listing rounded to cents (same toMoney as the siblings),
  // so one figure serialises identically across routes and tools.
  it.skipIf(!reachable)('money fields are 2-decimal and equal across listings (float-drift amounts)', async () => {
    const drift: J[] = [];
    for (let i = 0; i < 10; i += 1) drift.push(j(`2025-0${(i % 9) + 1}-10`, [[EXP, 0.1, 0], [BANK, 0, 0.1]]));   // prior FY: opening + RE-BF
    for (let i = 0; i < 10; i += 1) drift.push(j(`2026-0${(i % 6) + 4}-10`, [[EXP, 0.1, 0], [BANK, 0, 0.1]]));   // in range
    drift.push(j('2026-05-20', [[EXP, 0.2, 0], [BANK, 0, 0.2]]));
    await withData(drift, async () => {
      const ok = (n: number | null | undefined, what: string) => {
        expect(typeof n, what).toBe('number');
        expect(n, what).toBe(Math.round((n as number) * 100) / 100);
      };
      const ledger = await getAccountLedger({ ...q, limit: 500 });
      const inline = await getAccountTransactions(A, '5000', q.fromDate, q.toDate);
      const report = await getGeneralLedgerReport(A, q.fromDate, q.toDate);
      const rep = report.find(x => x.accountCode === '5000')!;
      const re = report.find(x => x.accountCode === 'RE-BF');
      expect(re, 'fixture must produce RE-BF').toBeDefined();
      for (const [what, n] of [
        ['ledger opening', ledger.openingBalance], ['ledger periodNet', ledger.periodNet], ['ledger closing', ledger.periodClosingBalance],
        ['inline opening', inline.openingBalance], ['inline periodNet', inline.periodNet], ['inline closing', inline.closingBalance],
        ['report opening', rep.openingBalance], ['report closing', rep.closingBalance],
        ['RE-BF opening', re!.openingBalance], ['RE-BF closing', re!.closingBalance],
        ...ledger.rows.map((r, i) => [`ledger row ${i}`, r.runningBalance] as [string, number]),
        ...inline.transactions.map((r, i) => [`inline row ${i}`, r.balance] as [string, number]),
        ...rep.transactions.map((r, i) => [`report row ${i}`, r.balance] as [string, number]),
        ...re!.transactions.map((r, i) => [`RE-BF row ${i}`, r.balance] as [string, number]),
      ] as Array<[string, number]>) ok(n, what);
      expect(inline.closingBalance).toBe(ledger.periodClosingBalance);
      expect(rep.closingBalance).toBe(ledger.periodClosingBalance);
      expect(inline.periodNet).toBe(ledger.periodNet);
      expect(inline.openingBalance).toBe(ledger.openingBalance);
    });
  }, 60000);

  // Round 6: created_at is nullable. NULL sorts as the epoch EVERYWHERE, so the order stays total
  // and identical across listings and the stream's cursor keeps serving every line.
  it.skipIf(!reachable)('NULL created_at: one order across listings, and cursor paging serves every line once', async () => {
    const js: J[] = [j('2025-06-10', [[EXP, 1000, 0], [BANK, 0, 1000]])];
    for (let i = 0; i < 9; i += 1) js.push(j('2026-04-10', [[EXP, 10 + i, 0], [BANK, 0, 10 + i]], i < 4 ? null : '2026-04-10T08:00:00Z'));
    js.push(j('2026-04-11', [[EXP, 500, 0], [BANK, 0, 500]], null));
    await withData(js, async () => {
      const full = await getAccountLedger({ ...q, limit: 500 });
      const seq = full.rows.map(r => [r.debit, r.runningBalance]);
      for (const size of [1, 2, 7]) {
        const got: typeof full.rows = [];
        for (let off = 0; off < full.total; off += size) got.push(...(await getAccountLedger({ ...q, limit: size, offset: off })).rows);
        expect(got.map(r => [r.debit, r.runningBalance]), `size ${size}`).toEqual(seq);
      }
      const inline = await getAccountTransactions(A, '5000', q.fromDate, q.toDate);
      const rep = (await getGeneralLedgerReport(A, q.fromDate, q.toDate)).find(x => x.accountCode === '5000')!;
      const whole = await getGeneralLedgerLines({ companyId: A, periodStart: q.fromDate, periodEnd: q.toDate, accountCodes: ['5000'], limit: 100 });
      expect(inline.transactions.map(r => [r.debit, r.balance])).toEqual(seq);
      expect(rep.transactions.map(r => [r.debit, r.balance])).toEqual(seq);
      expect(whole.lines.map(l => [l.debit, l.runningBalance])).toEqual(seq);
      // NULL-created journals come first within a date (epoch), then the stamped ones.
      expect(seq.slice(0, 4).map(x => x[0]).sort((a, b) => a! - b!)).toEqual([10, 11, 12, 13]);
      // cursor paging, limit 1
      const served: number[] = [];
      let after = null as Awaited<ReturnType<typeof getGeneralLedgerLines>>['next'];
      for (let g = 0; g < 40; g += 1) {
        const page = await getGeneralLedgerLines({ companyId: A, periodStart: q.fromDate, periodEnd: q.toDate, accountCodes: ['5000'], limit: 1, after });
        served.push(...page.lines.map(l => l.debit));
        if (!page.next) break;
        after = page.next;
      }
      expect(served).toEqual(seq.map(x => x[0]));
    });
  }, 60000);

  // Round 7: the Bank Transactions report is the same kind of listing (one account, per-row running
  // balance) over the same journals, so a bank account must show the same row order and balances there.
  it.skipIf(!reachable)('getBankTransactions orders and balances a bank account exactly as the account ledger does', async () => {
    const js = [
      j('2026-04-10', [[BANK, 100, 0], [EXP, 0, 100]], null),
      j('2026-04-10', [[BANK, 0, 7], [EXP, 7, 0]], '2026-04-10T08:00:00Z'),
      j('2026-04-10', [[BANK, 3, 0], [EXP, 0, 3]], '2026-04-10T09:00:00Z'),
      j('2026-04-10', [[BANK, 0, 1], [EXP, 1, 0]], null),
    ];
    await withData(js, async () => {
      const ledger = await getAccountLedger({ companyId: A, accountCode: '1100', fromDate: '2026-04-01', toDate: '2026-04-30', limit: 500 });
      const bank = await getBankTransactions(A, '2026-04-01', '2026-04-30', '1100');
      expect(bank.transactions.map(t => [t.deposit - t.withdrawal, t.runningBalance]))
        .toEqual(ledger.rows.map(r => [r.debit - r.credit, r.runningBalance]));
    });
  }, 60000);
});

