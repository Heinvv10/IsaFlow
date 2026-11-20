/**
 * Wave 6 VR, review round 2 (rev-1555 VAT breaker, adopted T1-T6) plus the draft-survival repro (note 2):
 *   T1  an amended version is unsubmitted until its top-up; a concurrent double top-up posts once and the loser is a
 *       typed 409 VAT_ALREADY_SETTLED (L1); a second amend tops up again; the control account clears.
 *   T2  a refund top-up posts the right signs and clears 2120 and 1140.
 *   T3  an amend that moves no tax figure settles as a NIL top-up row linked to the new version (M): submitted.
 *   T4  the next-lock exemption: a spoofed source by route, day 2 of the lock, a previous period only amended, and a
 *       sale's lines carrying the clearing source (L2) are all refused.
 *   T5  a top-up into a locked next period leaves the next VAT201 and its version unchanged.
 *   T6  ledger gap: blank / zero-width reasons 400, a manager 403, a top-up re-records the period gap.
 *   T7  a settlement whose clearing journal cannot post (its fiscal period is closed) leaves no draft journal and no row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';
import versions from '../../pages/api/accounting/sars/returns/[form]/versions';
import vatReturns from '../../pages/api/accounting/vat-returns/index';
import journalEntries from '../../pages/api/accounting/journal-entries';
import { vatPeriodFiling } from '@/modules/accounting/services/returns/vatPeriodFilings';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
type P = { periodStart: string; periodEnd: string };
let rf: ReturnFixture;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const acct = async (code: string) => String((await one(sql`SELECT id FROM gl_accounts
  WHERE company_id = ${rf.fx.companyId}::UUID AND account_code = ${code}`)).id);
const settle = (p: P, extra: Row = {}) => callRoute(vatReturns, rf.fx.companyId, rf.admin.token, 'POST', {}, { ...p, ...extra });
const finaliseP = (p: P) => callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'vat201' },
  { ...p, force: true, overrideReason: 'breaker', acknowledgeVatReturnMismatch: true, mismatchReason: 'breaker amend' });
const live = async (p: P) => ((await callRoute(versions, rf.fx.companyId, rf.admin.token, 'GET', { form: 'vat201', ...p }))
  .body as { data: { versions: Row[] } }).data.versions.find((v) => v.status !== 'superseded')!;
const amendLive = async (p: P) => callRoute(amend, rf.fx.companyId, rf.admin.token, 'POST', { form: 'vat201' },
  { versionId: String((await live(p)).id), reason: 'breaker amend' });
const code = (r: { body: unknown }) => (r.body as { error?: { details?: { code?: string } } }).error?.details?.code;

async function journal(date: string, lines: [string, number, number][]): Promise<void> {
  const c = rf.fx.companyId;
  const je = String((await one(sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c}::UUID, ${date}::DATE, 'breaker', 'posted', ${rf.fx.userId}::UUID) RETURNING id`)).id);
  for (const [code, debit, credit] of lines) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${c}::UUID, ${je}::UUID, ${await acct(code)}::UUID, ${debit}, ${credit})`;
  }
}
const sale = (date: string, net: number) => journal(date, [['1100', net * 1.15, 0], ['2120', 0, net * 0.15], ['6000', 0, net]]);
/** Balance (credit - debit) of a control account over all posted journals. */
const bal = async (code: string) => Number((await one(sql`SELECT COALESCE(SUM(l.credit - l.debit), 0) AS b
  FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id JOIN gl_accounts a ON a.id = l.gl_account_id
  WHERE l.company_id = ${rf.fx.companyId}::UUID AND e.status = 'posted' AND a.account_code = ${code}`)).b);
const rows = async (p: P) => (await sql`SELECT return_version_id, total_output_tax::float AS o, total_input_tax::float AS i,
  net_vat::float AS n FROM vat_returns WHERE company_id = ${rf.fx.companyId}::UUID AND period_start = ${p.periodStart}::DATE
  ORDER BY submitted_at`) as Row[];

const P1 = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
const P2 = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const P3 = { periodStart: '2026-06-01', periodEnd: '2026-07-31' };
const P4 = { periodStart: '2025-04-01', periodEnd: '2025-05-31' };
const P5 = { periodStart: '2025-06-01', periodEnd: '2025-07-31' };

const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('VR review round 2: top-ups, races, the next-lock exemption, the ledger gap', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, journals, invoices, VAT locks, return versions and settlements.');
    rf = await seedReturnFixture('BR2', DATABASE_URL!);
    await sql`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd' WHERE id = ${rf.fx.companyId}::UUID`;
  }, 240000);
  afterAll(async () => {
    if (rf) { await sql`DELETE FROM vat_returns WHERE company_id = ${rf.fx.companyId}::UUID`; await dropReturnFixture(rf); }
  }, 120000);

  it('T1 H1: amended v2 is unsubmitted until its top-up; concurrent double top-up posts once; top-up after a second amend', async () => {
    await sale('2026-02-15', 10000);
    expect((await finaliseP(P1)).status).toBe(200);
    expect((await settle(P1)).status).toBe(200);
    expect((await amendLive(P1)).status).toBe(200);
    await sale('2026-02-20', 10000);
    expect((await finaliseP(P1)).status).toBe(200);
    const before = (await vatPeriodFiling(rf.fx.companyId, P1.periodStart, P1.periodEnd))!;
    expect(before.submitted).toBe(false);
    const [a, b] = await Promise.all([settle(P1), settle(P1)]);
    const loser = a.status === 200 ? b : a;
    expect(Number((await one(sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${rf.fx.companyId}::UUID
      AND source = 'auto_vat_submission'`)).n)).toBe(2); // the first settlement and ONE top-up: the loser's journal rolled back
    expect([a.status, b.status].filter((x) => x === 200).length).toBe(1);
    const again = await settle(P1);
    expect([again.status, code(again)]).toEqual([409, 'VAT_ALREADY_SETTLED']);
    expect((await amendLive(P1)).status).toBe(200);
    await sale('2026-03-05', 20000);
    expect((await finaliseP(P1)).status).toBe(200);
    const t3 = await settle(P1);
    expect(t3.status, JSON.stringify(t3.body)).toBe(200);
    const r = await rows(P1);
    expect(r.map((x) => x.n)).toEqual([1500, 1500, 3000]);
    expect(await bal('2120')).toBeCloseTo(0, 2);
    expect((await vatPeriodFiling(rf.fx.companyId, P1.periodStart, P1.periodEnd))!.submitted).toBe(true);
    expect([loser.status, code(loser)]).toEqual([409, 'VAT_ALREADY_SETTLED']); // race loser: a typed refusal, not a raw 400
  }, 120000);

  it('T2 refund: amended net goes negative; the top-up posts the right signs and clears 2120 and 1140', async () => {
    await sale('2026-04-10', 10000);
    expect((await finaliseP(P2)).status).toBe(200);
    expect((await settle(P2)).status).toBe(200);
    expect((await amendLive(P2)).status).toBe(200);
    await journal('2026-04-20', [['6000', 6000, 0], ['2120', 900, 0], ['1100', 0, 6900]]); // credit note: output -900
    await journal('2026-05-05', [['1140', 3000, 0], ['6000', 20000, 0], ['1100', 0, 23000]]); // purchase: input 3000
    expect((await finaliseP(P2)).status).toBe(200);
    const v2 = await live(P2);
    const t = await settle(P2);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const r = await rows(P2);
    const je = String((t.body as { data: Row }).data.journalEntryId);
    const lines = await sql`SELECT a.account_code, l.debit::float AS d, l.credit::float AS c FROM gl_journal_lines l
      JOIN gl_accounts a ON a.id = l.gl_account_id WHERE l.journal_entry_id = ${je}::UUID ORDER BY a.account_code`;
    expect(r[1]).toMatchObject({ o: -900, i: 3000, n: -3900 });
    // Refund top-up: output fell 900 (CR 2120), input rose 3000 (CR 1140), the net refund 3900 parked as a DEBIT on the
    // net-VAT account (this fixture has no 2130, so resolveNetVatAccount falls back to the payables account, 2100).
    expect((lines as Row[]).map((l) => [l.account_code, l.d, l.c])).toEqual([
      ['1140', 0, 3000], ['2100', 3900, 0], ['2120', 0, 900],
    ]);
    expect(r.reduce((s, x) => s + Number(x.n), 0)).toBeCloseTo(Number((v2.figures as Row).netVat), 2);
    expect(await bal('2120')).toBeCloseTo(0, 2);
    expect(await bal('1140')).toBeCloseTo(0, 2);
  }, 120000);

  it('T3 an amend that moves no tax figure settles as a nil top-up linked to the new version, and reads as submitted', async () => {
    await sale('2026-06-10', 10000);
    expect((await finaliseP(P3)).status).toBe(200);
    expect((await settle(P3)).status).toBe(200);
    expect((await amendLive(P3)).status).toBe(200);
    expect((await finaliseP(P3)).status).toBe(200);
    const v2 = await live(P3);
    const s = await settle(P3);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect((s.body as { data: Row }).data).toMatchObject({ totalOutputTax: 0, totalInputTax: 0, netVat: 0, returnVersionId: v2.id });
    expect((s.body as { data: Row }).data.journalEntryId).toBeUndefined();
    const f = (await vatPeriodFiling(rf.fx.companyId, P3.periodStart, P3.periodEnd))!;
    expect(f.submitted).toBe(true);
    expect(f.settlement).toMatchObject({ linkedToVersion: true, returnVersionId: v2.id, count: 2, netVat: 1500 });
    const again = await settle(P3);
    expect([again.status, code(again)]).toEqual([409, 'VAT_ALREADY_SETTLED']);
  }, 120000);

  it('T4 exemption: spoofed source by route; day 2 of the lock; previous period only draft; non-clearing lines', async () => {
    const c = rf.fx.companyId;
    await sale('2025-04-10', 1000);
    await sale('2025-06-10', 2000);
    const f4 = await finaliseP(P4);
    const f5 = await finaliseP(P5);
    expect(f4.status).toBe(200); expect(f5.status).toBe(200);
    const reportBefore = (await getVat201Report(c, P5.periodStart, P5.periodEnd, { detail: 'summary' })).totals;
    const saleLines = async () => [
      { glAccountId: await acct('1100'), debit: 115, credit: 0 },
      { glAccountId: await acct('2120'), debit: 0, credit: 15 },
      { glAccountId: await acct('6000'), debit: 0, credit: 100 },
    ];
    // (a) the route refuses the source outright
    const r = await callRoute(journalEntries, c, rf.admin.token, 'POST', {}, {
      entryDate: '2025-06-01', description: 'spoof', source: 'auto_vat_submission', lines: await saleLines() });
    expect(r.status).toBe(400);
    const tryCreate = async (date: string) => createJournalEntry(c, { entryDate: date, description: 'spoof',
      source: 'auto_vat_submission', lines: await saleLines() }, rf.admin.userId).then((e) => e, (e: unknown) => e);
    // (b) day 2 of the lock
    const d2 = await tryCreate('2025-06-02');
    expect(d2).toBeInstanceOf(VatPeriodLockedError);
    // (d) lock day 1, previous finalised, but lines that are a SALE, not a clearing: the exemption takes it
    const d1 = await tryCreate('2025-06-01');
    const reportAfter = (await getVat201Report(c, P5.periodStart, P5.periodEnd, { detail: 'summary' })).totals;
    expect(reportAfter).toEqual(reportBefore);
    // (c) previous period only draft (amended, not re-finalised)
    expect((await amendLive(P4)).status).toBe(200);
    const dr = await tryCreate('2025-06-01');
    expect(dr).toBeInstanceOf(VatPeriodLockedError);
    const s = await settle(P4);
    expect([s.status, code(s)]).toEqual([409, 'VAT201_NOT_FINALISED']);
    expect(d1).toBeInstanceOf(VatPeriodLockedError); // defence in depth: only clearing lines should be exempt
  }, 120000);

  it('T5 a top-up into a locked next period leaves the next VAT201 and its version unchanged', async () => {
    const c = rf.fx.companyId;
    // P4 is draft (T4); re-finalise, settle, amend with more sales, re-finalise, top-up while P5 is locked.
    expect((await finaliseP(P4)).status).toBe(200);
    expect((await settle(P4)).status).toBe(200);
    const p5Before = await live(P5);
    const rep = async () => (await getVat201Report(c, P5.periodStart, P5.periodEnd, { detail: 'summary' }));
    const before = await rep();
    expect((await amendLive(P4)).status).toBe(200);
    await sale('2025-05-10', 4000);
    expect((await finaliseP(P4)).status).toBe(200);
    const t = await settle(P4);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const after = await rep();
    const p5After = await live(P5);
    expect(after.totals).toEqual(before.totals);
    expect(after.boxes).toEqual(before.boxes);
    expect(p5After.id).toBe(p5Before.id);
    expect((p5After.drift as { fields: unknown[] }).fields).toEqual([]);
    const s5 = await settle(P5);
    expect(s5.status, JSON.stringify(s5.body)).toBe(200);
    expect(await bal('2120')).toBeCloseTo(0, 2);
  }, 120000);

  it('T6 ledger gap: whitespace/zero-width reason refused; manager refused; top-up re-records the period gap', async () => {
    const c = rf.fx.companyId;
    const G = { periodStart: '2025-08-01', periodEnd: '2025-09-30' };
    await sale('2025-08-10', 10000);
    await sale('2025-08-20', 300);
    const je = String((await one(sql`SELECT id FROM gl_journal_entries WHERE company_id = ${c}::UUID AND entry_date = '2025-08-20'`)).id);
    const cust = String((await one(sql`INSERT INTO customers (company_id, name) VALUES (${c}::UUID, 'BR2 cust') RETURNING id`)).id);
    await sql`INSERT INTO customer_invoices (company_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
        status, created_by, invoice_date, gl_journal_entry_id)
      VALUES (${c}::UUID, 'INV-BR2-1', ${cust}::UUID, 300, 45, 345, 'cancelled', ${rf.fx.userId}, '2025-08-20'::DATE, ${je}::UUID)`;
    expect((await finaliseP(G)).status).toBe(200);
    const statuses: unknown[] = [];
    for (const reason of ['   ', '\u200B\u200B', '\t\n']) {
      const r = await settle(G, { acknowledgeLedgerGap: true, ledgerGapReason: reason });
      statuses.push(r.status);
    }
    const mgr = await callRoute(vatReturns, c, rf.manager.token, 'POST', {}, { ...G, acknowledgeLedgerGap: true, ledgerGapReason: 'x' });
    expect(statuses).toEqual([400, 400, 400]);
    expect(mgr.status).toBe(403);
    expect((await settle(G, { acknowledgeLedgerGap: true, ledgerGapReason: 'cancelled inv' })).status).toBe(200);
    expect((await amendLive(G)).status).toBe(200);
    await sale('2025-09-10', 10000);
    expect((await finaliseP(G)).status).toBe(200);
    const noAck = await settle(G);
    const t = await settle(G, { acknowledgeLedgerGap: true, ledgerGapReason: 'still the cancelled inv' });
    const r = await sql`SELECT net_vat::float AS n, ledger_gap_ledger_net::float AS l, ledger_gap_report_net::float AS rp
      FROM vat_returns WHERE company_id = ${c}::UUID AND period_start = '2025-08-01' ORDER BY submitted_at`;
    expect([noAck.status, code(noAck)]).toEqual([409, 'VAT_SETTLEMENT_LEDGER_GAP']);
    expect(t.status).toBe(200);
    expect(r).toEqual([{ n: 1545, l: 1545, rp: 1500 }, { n: 1500, l: 3045, rp: 3000 }]); // period figures each time
    expect(await bal('2120')).toBeCloseTo(0, 2);
  }, 120000);

  it('T7 a settlement whose clearing journal cannot post (closed fiscal period) leaves no draft journal and no row', async () => {
    const c = rf.fx.companyId;
    const P7 = { periodStart: '2025-10-01', periodEnd: '2025-11-30' };
    await sale('2025-10-10', 1000);
    expect((await finaliseP(P7)).status).toBe(200);
    const period = await one(sql`SELECT id, status FROM fiscal_periods WHERE company_id = ${c}::UUID
      AND start_date <= '2025-12-01'::DATE AND end_date >= '2025-12-01'::DATE`);
    expect(period, 'the fixture has a fiscal period for the clearing date').toBeTruthy();
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE id = ${String(period.id)}::UUID`;
    try {
      const s = await settle(P7);
      expect(s.status).toBeGreaterThanOrEqual(400);
      expect(s.status).toBeLessThan(500);
      const left = await one(sql`SELECT
        (SELECT COUNT(*)::int FROM gl_journal_entries WHERE company_id = ${c}::UUID AND source = 'auto_vat_submission'
           AND entry_date = '2025-12-01'::DATE) AS journals,
        (SELECT COUNT(*)::int FROM vat_returns WHERE company_id = ${c}::UUID AND period_start = '2025-10-01'::DATE) AS rows`);
      expect(left).toEqual({ journals: 0, rows: 0 }); // no draft survives the refusal, whatever its status
    } finally {
      await sql`UPDATE fiscal_periods SET status = ${String(period.status)} WHERE id = ${String(period.id)}::UUID`;
    }
  }, 120000);
});

