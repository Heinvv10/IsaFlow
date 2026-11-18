/**
 * Wave 6 VR, coordinator ruling on review round 1 (M3), on a real ledger: what a VAT settlement may be posted from.
 *
 *   LEDGER GAP  the VAT control accounts and the VAT201 disagree for a reason re-finalising cannot fix: here an invoice
 *               cancelled with its journal still posted (the VAT201 leaves its VAT out, the control account keeps it;
 *               Demo's Jul-Aug 2026 is the same shape). Refused 409 naming both figures; a manager may not override;
 *               an admin settles with a reason, the settlement posts the LEDGER figures (2120 clears), and the reason
 *               and both figures are on the row and in the versions endpoint the drawer reads.
 *   DRIFT       the ledger moved after finalising (a post straight into the locked period): refused 409 and NOT
 *               overridable, acknowledgement or not.
 * Every refusal is counted after the response: no vat_returns row and no journal (withAuth commits a 4xx).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import versions from '../../pages/api/accounting/sars/returns/[form]/versions';
import vatReturns from '../../pages/api/accounting/vat-returns/index';
import { inAppUserTx } from './helpers/appUserTx';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type P = { periodStart: string; periodEnd: string };

const GAP = { periodStart: '2026-08-01', periodEnd: '2026-09-30' };
const DRIFT = { periodStart: '2025-12-01', periodEnd: '2026-01-31' };
const REASON = 'INV-VRG-1 was cancelled after posting; its R45 output VAT is still in 2120. Reversal booked next period.';

let rf: ReturnFixture;
const settle = (token: string, p: P, extra: Record<string, unknown> = {}) =>
  callRoute(vatReturns, rf.fx.companyId, token, 'POST', {}, { ...p, ...extra });
const finaliseP = (p: P) => callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'vat201' },
  { ...p, force: true, overrideReason: 'VR fixture' });
const code = (r: { body: unknown }) => (r.body as { error?: { details?: { code?: string } } }).error?.details?.code;
const details = (r: { body: unknown }) => (r.body as { error?: { details?: Row } }).error?.details;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const counts = async (c: string) => one(sql`SELECT
  (SELECT COUNT(*)::INT FROM vat_returns WHERE company_id = ${c}::UUID) AS settlements,
  (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${c}::UUID) AS journals`);

/** A posted sale of `net` + 15 % VAT inside the period, written straight to the ledger; returns its journal id. */
async function sale(date: string, net: number): Promise<string> {
  const c = rf.fx.companyId;
  const acct = async (codeNo: string) => String((await one(sql`SELECT id FROM gl_accounts
    WHERE company_id = ${c}::UUID AND account_code = ${codeNo}`)).id);
  const je = String((await one(sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c}::UUID, ${date}::DATE, 'VR sale', 'posted', ${rf.fx.userId}::UUID) RETURNING id`)).id);
  for (const [codeNo, debit, credit] of [['1100', net * 1.15, 0], ['2120', 0, net * 0.15], ['6000', 0, net]] as const) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${c}::UUID, ${je}::UUID, ${await acct(codeNo)}::UUID, ${debit}, ${credit})`;
  }
  return je;
}

/** Balance movement on a control account across every posted journal of the company (credit - debit). */
const control = async (c: string, codeNo: string) => Number((await one(sql`
  SELECT COALESCE(SUM(l.credit - l.debit), 0) AS b FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id JOIN gl_accounts a ON a.id = l.gl_account_id
   WHERE l.company_id = ${c}::UUID AND e.status = 'posted' AND a.account_code = ${codeNo}`)).b);

describeIfDb('VR: a ledger gap is acknowledged with a reason; drift is never overridable', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, journals, invoices, VAT locks, return versions and settlements.');
    rf = await seedReturnFixture('VRG', DATABASE_URL!);
    await sql`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd' WHERE id = ${rf.fx.companyId}::UUID`;
  }, 240000);

  afterAll(async () => {
    if (!rf) return;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${rf.fx.companyId}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${rf.fx.companyId}::UUID`;
    await dropReturnFixture(rf);
  }, 120000);

  it('ledger gap: refused naming both figures, not by a manager, then settled by an admin with the reason kept', async () => {
    const c = rf.fx.companyId;
    await sale('2026-08-10', 10000);
    const cancelledJe = await sale('2026-08-20', 300); // R45 of VAT the VAT201 leaves out once its invoice is cancelled
    const cust = String((await one(sql`INSERT INTO customers (company_id, name) VALUES (${c}::UUID, 'VRG customer')
      RETURNING id`)).id);
    await sql`INSERT INTO customer_invoices (company_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
        status, created_by, invoice_date, gl_journal_entry_id)
      VALUES (${c}::UUID, 'INV-VRG-1', ${cust}::UUID, 300, 45, 345, 'cancelled', ${rf.fx.userId}, '2026-08-20'::DATE,
        ${cancelledJe}::UUID)`;
    expect((await finaliseP(GAP)).status).toBe(200);

    const before = await counts(c);
    const refused = await settle(rf.admin.token, GAP);
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('VAT_SETTLEMENT_LEDGER_GAP');
    expect(details(refused)).toMatchObject({ ledgerNetVat: 1545, reportNetVat: 1500 });
    const asManager = await settle(rf.manager.token, GAP, { acknowledgeLedgerGap: true, ledgerGapReason: REASON });
    expect(asManager.status).toBe(403);
    const noReason = await settle(rf.admin.token, GAP, { acknowledgeLedgerGap: true });
    expect(noReason.status).toBe(400);
    const tooLong = await settle(rf.admin.token, GAP, { acknowledgeLedgerGap: true, ledgerGapReason: 'x'.repeat(1001) });
    expect(tooLong.status).toBe(400); // the cap is 1000 characters (round-2 security L-c)
    expect(JSON.stringify(tooLong.body)).toContain('at most 1000 characters');
    expect(await counts(c)).toEqual(before);

    const ok = await settle(rf.admin.token, GAP, { acknowledgeLedgerGap: true, ledgerGapReason: REASON });
    expect(ok.status).toBe(200);
    expect((ok.body as { data: Row }).data).toMatchObject({
      totalOutputTax: 1545, netVat: 1545, ledgerGap: { ledgerNetVat: 1545, reportNetVat: 1500, reason: REASON },
    });
    expect(await one(sql`SELECT ledger_gap_ledger_net::FLOAT8 AS l, ledger_gap_report_net::FLOAT8 AS r, ledger_gap_reason
      FROM vat_returns WHERE company_id = ${c}::UUID`)).toEqual({ l: 1545, r: 1500, ledger_gap_reason: REASON });
    expect(await control(c, '2120')).toBe(0); // the ledger figures were posted, so the control account clears

    const q = { form: 'vat201', periodStart: GAP.periodStart, periodEnd: GAP.periodEnd };
    const view = await callRoute(versions, c, rf.admin.token, 'GET', q);
    expect((view.body as { data: { vatReturn: Row } }).data.vatReturn).toMatchObject({
      ledgerGap: { ledgerNetVat: 1545, reportNetVat: 1500, reason: REASON },
    });
  });

  it('drift: the ledger moved after finalising; refused 409, and an acknowledgement does not override it', async () => {
    const c = rf.fx.companyId;
    await sale('2025-12-10', 10000);
    expect((await finaliseP(DRIFT)).status).toBe(200);
    await sale('2026-01-10', 1000); // straight to the ledger, past the lock
    const before = await counts(c);
    for (const extra of [{}, { acknowledgeLedgerGap: true, ledgerGapReason: REASON }]) {
      const r = await settle(rf.admin.token, DRIFT, extra);
      expect(r.status).toBe(409);
      expect(code(r)).toBe('VAT_SETTLEMENT_DRIFT');
      expect(details(r)).toMatchObject({ versionNetVat: 1500, reportNetVat: 1650 });
    }
    expect(await counts(c)).toEqual(before);
  });

  it.each([
    ['spaces and a tab', ' \t'],
    ['a zero-width space', '\u200B'],
    ['1001 characters', 'x'.repeat(1001)],
  ])('the database refuses a gap reason of %s, as app_user (vat_returns_ledger_gap_ck)', async (_what, reason) => {
    const err = await inAppUserTx(rf.fx, () => sql`INSERT INTO vat_returns (company_id, period_start, period_end,
        total_output_tax, total_input_tax, net_vat, ledger_gap_ledger_net, ledger_gap_report_net, ledger_gap_reason)
      VALUES (${rf.fx.companyId}::UUID, '2025-02-01'::DATE, '2025-03-31'::DATE, 0, 0, 0, 1, 2, ${reason})`)
      .then(() => null, (e: unknown) => e as { code?: string; constraint?: string });
    expect(err).toMatchObject({ code: '23514', constraint: 'vat_returns_ledger_gap_ck' });
  });

  it('the database accepts a visible reason of exactly 1000 characters, as app_user', async () => {
    await inAppUserTx(rf.fx, async () => {
      await sql`INSERT INTO vat_returns (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat,
          ledger_gap_ledger_net, ledger_gap_report_net, ledger_gap_reason)
        VALUES (${rf.fx.companyId}::UUID, '2025-02-01'::DATE, '2025-03-31'::DATE, 0, 0, 0, 1, 2, ${'y'.repeat(1000)})`;
      await sql`DELETE FROM vat_returns WHERE company_id = ${rf.fx.companyId}::UUID AND period_start = '2025-02-01'::DATE`;
    });
  });
});

