/**
 * Wave 6 VR, review round 3 (rev-1555 VAT breaker, adopted T8a, T8b, T9):
 *   T8a  after an amend whose VAT201 moved but whose ledger did not, the settlement is a ledger gap (409 unless
 *        acknowledged); acknowledged, it is a nil top-up row carrying the period's figures: the nil row hides nothing.
 *   T8b  an amend moving output AND input equally (net unchanged) posts a journal for both, not a nil row.
 *   T9   the next-lock exemption accepts only THE net-VAT account the settlement posts to: with an active 2130, a trade
 *        payables line is refused; the same clearing onto 2130 posts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';
import versions from '../../pages/api/accounting/sars/returns/[form]/versions';
import vatReturns from '../../pages/api/accounting/vat-returns/index';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';

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

const P4 = { periodStart: '2025-04-01', periodEnd: '2025-05-31' };
const P5 = { periodStart: '2025-06-01', periodEnd: '2025-07-31' };

const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('VR review round 3: nil rows hide nothing; the exemption takes only the net-VAT account', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, journals, invoices, accounts, VAT locks, return versions and settlements.');
    rf = await seedReturnFixture('VR3', DATABASE_URL!);
    await sql`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd' WHERE id = ${rf.fx.companyId}::UUID`;
  }, 240000);
  afterAll(async () => {
    if (!rf) return;
    await sql`DELETE FROM vat_returns WHERE company_id = ${rf.fx.companyId}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${rf.fx.companyId}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${rf.fx.companyId}::UUID`;
    await dropReturnFixture(rf);
  }, 120000);

  it('T8a nil row cannot hide a report-side tax change: amend changes VAT201 tax, ledger unchanged -> gap 409 unless acked', async () => {
    const c = rf.fx.companyId;
    const G = { periodStart: '2025-10-01', periodEnd: '2025-11-30' };
    await sale('2025-10-10', 10000);
    await sale('2025-10-20', 300);
    expect((await finaliseP(G)).status).toBe(200);
    expect((await settle(G)).status).toBe(200);
    expect((await amendLive(G)).status).toBe(200);
    const je = String((await one(sql`SELECT id FROM gl_journal_entries WHERE company_id = ${c}::UUID AND entry_date = '2025-10-20'`)).id);
    const cust = String((await one(sql`INSERT INTO customers (company_id, name) VALUES (${c}::UUID, 'BR3 cust') RETURNING id`)).id);
    await sql`INSERT INTO customer_invoices (company_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
        status, created_by, invoice_date, gl_journal_entry_id)
      VALUES (${c}::UUID, 'INV-BR3-1', ${cust}::UUID, 300, 45, 345, 'cancelled', ${rf.fx.userId}, '2025-10-20'::DATE, ${je}::UUID)`;
    expect((await finaliseP(G)).status).toBe(200);
    const v2 = await live(G);
    expect((v2.figures as Row).netVat).toBe(1500); // the VAT201 dropped the cancelled invoice; the ledger did not
    const noAck = await settle(G);
    const before = await rows(G);
    expect([noAck.status, code(noAck)]).toEqual([409, 'VAT_SETTLEMENT_LEDGER_GAP']);
    expect(before.length).toBe(1);
    const ack = await settle(G, { acknowledgeLedgerGap: true, ledgerGapReason: 'cancelled after settling' });
    const r = await sql`SELECT net_vat::float AS n, journal_entry_id, ledger_gap_ledger_net::float AS l, ledger_gap_report_net::float AS rp
      FROM vat_returns WHERE company_id = ${c}::UUID AND period_start = '2025-10-01' ORDER BY submitted_at`;
    expect(ack.status).toBe(200);
    expect((r as Row[])[1]).toMatchObject({ n: 0, journal_entry_id: null, l: 1545, rp: 1500 });
  }, 120000);

  it('T8b an amend moving output AND input equally (net unchanged) posts a journal, not a nil row', async () => {
    const G = { periodStart: '2025-12-01', periodEnd: '2026-01-31' };
    await sale('2025-12-10', 10000);
    expect((await finaliseP(G)).status).toBe(200);
    expect((await settle(G)).status).toBe(200);
    expect((await amendLive(G)).status).toBe(200);
    await sale('2025-12-15', 2000); // output +300
    await journal('2025-12-16', [['1140', 300, 0], ['6000', 2000, 0], ['1100', 0, 2300]]); // input +300
    expect((await finaliseP(G)).status).toBe(200);
    const t = await settle(G);
    const r = await rows(G);
    expect(t.status).toBe(200);
    expect(r[1]).toMatchObject({ o: 300, i: 300, n: 0 });
    expect((t.body as { data: Row }).data.journalEntryId).not.toBeNull();
    expect(await bal('2120')).toBeCloseTo(0, 2);
    expect(await bal('1140')).toBeCloseTo(0, 2);
  }, 120000);

  it('T9 exemption breadth: clearing source with a TRADE PAYABLES line (DR AP / CR 1140) on lock day 1', async () => {
    const c = rf.fx.companyId;
    // P4 finalised (the period a clearing would settle), P5 finalised (its lock starts on 2025-06-01).
    await sale('2025-04-10', 1000);
    await sale('2025-06-10', 2000);
    expect((await finaliseP(P4)).status).toBe(200);
    expect((await finaliseP(P5)).status).toBe(200);
    const ap = (await sql`SELECT id, account_code, account_subtype FROM gl_accounts WHERE company_id = ${c}::UUID
      AND account_subtype IN ('payable','accounts_payable','trade_payables','creditors') ORDER BY account_code`) as Row[];
    const tmpl = await one(sql`SELECT account_type, normal_balance FROM gl_accounts WHERE company_id = ${c}::UUID AND account_code = '2100'`);
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${c}::UUID, '2130', 'Accrued Expenses', ${tmpl.account_type}, ${tmpl.normal_balance}, true)`;
    const apId = String(ap.find((a) => a.account_code !== '2130')!.id);
    const res = await createJournalEntry(c, { entryDate: '2025-06-01', description: 'AP reclass of input VAT',
      source: 'auto_vat_submission', lines: [
        { glAccountId: apId, debit: 50, credit: 0 },
        { glAccountId: await acct('1140'), debit: 0, credit: 50 },
      ] }, rf.admin.userId).then((e) => e, (e: unknown) => e);
    // When 2130 exists, only 2130 is the net-VAT account (resolveNetVatAccount's choice); trade AP is not a clearing line.
    expect(res).toBeInstanceOf(VatPeriodLockedError);
    // The same reclass onto 2130 IS a clearing (DR 2130 / CR 1140): exempt, it posts.
    const ok = await createJournalEntry(c, { entryDate: '2025-06-01', description: 'net VAT clearing',
      source: 'auto_vat_submission', lines: [
        { glAccountId: await acct('2130'), debit: 50, credit: 0 },
        { glAccountId: await acct('1140'), debit: 0, credit: 50 },
      ] }, rf.admin.userId).then((e) => e, (e: unknown) => e);
    expect(ok).not.toBeInstanceOf(Error);
  }, 120000);
});
