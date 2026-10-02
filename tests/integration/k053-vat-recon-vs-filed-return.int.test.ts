/**
 * D7 round 3 (ported from brk-d7 V1/V2) — the VAT reconciliation compares each
 * GL arm with the source that arm is supposed to equal, and leaves a deleted
 * document's reversal chain out of ONLY the arm that needs it.
 *
 *   revenue arm    -> invoice leg (customer_invoices, deleted ones kept in the
 *                     month they were raised): the chain must be left out.
 *   VAT arms       -> vat_returns, which submitVATReturn fills from the LEDGER
 *                     by entry date with no exclusion: the chain must stay in.
 *
 * Round 2 dropped the chain from the VAT arms as well, so a return that matched
 * the ledger exactly read as a variance against it.
 *
 *   V1: a LIVE invoice / bill reversed by hand in July (M), June and July filed,
 *       THEN the document deleted (the delete posts nothing).
 *   V2: deleted in June (R dated June: the period is open), R reversed by hand
 *       in August (R2), June and August filed; the document stays deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getVatReconciliation, type VatReconMonth } from '@/modules/accounting/services/reports/vatReconciliationService';
import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { sql } from '@/lib/neon';
import { type Co, makeCompany, cleanupAll, assertChainFixtureDb, inTx, arInvoice, apBill, journalOf, reverseTip } from './k053-chain.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const MONTH_END: Record<string, string> = { '06': '2026-06-30', '07': '2026-07-31', '08': '2026-08-31' };

async function file(co: Co, mm: string): Promise<void> {
  await inTx(co, () => submitVATReturn(co.id, { periodStart: `2026-${mm}-01`, periodEnd: MONTH_END[mm]! }, co.user));
}

function row(m: VatReconMonth): string {
  return `${m.month} rev ${m.glRevenue} out ${m.glOutputVat} in ${m.glInputVat} `
    + `revVar ${m.revenueVariance} outVar ${m.outputVatVariance} inVar ${m.inputVatVariance}`;
}

describeIfDb('D7 VAT recon: each GL arm against its own source', () => {
  const cos: Co[] = [];
  beforeAll(() => { assertChainFixtureDb(); });
  afterAll(() => cleanupAll(cos), 120000);

  it('V1: a live document hand-reversed in July, both months filed, then deleted', async () => {
    const co = await makeCompany('D7V1'); cos.push(co);
    const ar = await arInvoice(co, '-AR', '2026-06-15', 1000, 150);
    const ap = await apBill(co, '-AP', '2026-06-15', 400, 60);
    await reverseTip(co, await journalOf(co, ar), '2026-07-10');
    await reverseTip(co, await journalOf(co, ap), '2026-07-10');
    await file(co, '06');
    await file(co, '07');
    const july = await getVATReturn(co.id, '2026-07-01', '2026-07-31');
    // The premise: the filed July return is the ledger's July, M included.
    expect([july.totalOutputTax, july.totalInputTax]).toEqual([-150, -60]);

    await inTx(co, () => softDelete(co.id, 'customer_invoice', ar, co.user));
    await inTx(co, () => softDelete(co.id, 'supplier_invoice', ap, co.user));
    const recon = await getVatReconciliation(co.id, '2026-06-01', '2026-07-31');
    expect(recon.months.map(row)).toEqual([
      // Revenue: the deleted invoice stays in June on both legs, and M — a
      // link of a deleted document's chain — is not July revenue.
      '2026-06 rev 1000 out 150 in 60 revVar 0 outVar 0 inVar 0',
      // VAT: the ledger's July, which is what was filed.
      '2026-07 rev 0 out -150 in -60 revVar 0 outVar 0 inVar 0',
    ]);
    expect(recon.issues.filter((i) => /variance/i.test(i.message))).toEqual([]);
  }, 120000);

  it('V2: deleted in June, the delete reversal hand-reversed in August, June and August filed', async () => {
    const co = await makeCompany('D7V2'); cos.push(co);
    const ar = await arInvoice(co, '-AR', '2026-06-15', 1000, 150);
    const ap = await apBill(co, '-AP', '2026-06-15', 400, 60);
    await inTx(co, () => softDelete(co.id, 'customer_invoice', ar, co.user));
    await inTx(co, () => softDelete(co.id, 'supplier_invoice', ap, co.user));
    await reverseTip(co, await journalOf(co, ar), '2026-08-05');
    await reverseTip(co, await journalOf(co, ap), '2026-08-05');
    await file(co, '06');
    await file(co, '08');
    const june = await getVATReturn(co.id, '2026-06-01', '2026-06-30');
    const aug = await getVATReturn(co.id, '2026-08-01', '2026-08-31');
    expect([june.totalOutputTax, june.totalInputTax, aug.totalOutputTax, aug.totalInputTax]).toEqual([0, 0, 150, 60]);

    const recon = await getVatReconciliation(co.id, '2026-06-01', '2026-08-31');
    expect(recon.months.map(row)).toEqual([
      '2026-06 rev 1000 out 0 in 0 revVar 0 outVar 0 inVar 0',
      '2026-08 rev 0 out 150 in 60 revVar 0 outVar 0 inVar 0',
    ]);
    expect(recon.issues.filter((i) => /variance/i.test(i.message))).toEqual([]);
  }, 120000);

  it('V3: the rate\'s VAT and revenue come from one row set — a later-month chain link is in neither', async () => {
    // August carries a live sale AND the R2 of a document deleted in June. R2
    // undoes June's supply, so August's rate leaves it out of BOTH figures:
    // the ledger's VAT over the revenue arm read 30%.
    const co = await makeCompany('D7V3'); cos.push(co);
    const del = await arInvoice(co, '-DEL', '2026-06-15', 1000, 150);
    await inTx(co, () => softDelete(co.id, 'customer_invoice', del, co.user));
    await reverseTip(co, await journalOf(co, del), '2026-08-05');
    await arInvoice(co, '-LIVE', '2026-08-10', 1000, 150);

    const recon = await getVatReconciliation(co.id, '2026-08-01', '2026-08-31');
    expect(recon.months.map((m) => [m.month, m.glRevenue, m.glOutputVat, m.revenueVariance, m.effectiveVatRate]))
      .toEqual([['2026-08', 1000, 300, 0, 15]]);
    expect(recon.issues.filter((i) => /Effective VAT rate|variance/i.test(i.message))).toEqual([]);
  }, 120000);

  it('V4 (brk-d7 pass 2, P4): a deleted MIXED-rate invoice\'s reversal does not move the month\'s rate', async () => {
    // June: R500 at 15% + R500 zero-rated, filed and LOCKED, so the delete's
    // reversal rolls into July. July's own trade is R2000 at 15%. On the
    // ledger, July reads R225 of output VAT over R1000 of revenue — 22.5% and a
    // "possible misclassification" issue for a month whose supplies are all
    // standard-rated. The rate is a question about the month's trade, so it
    // divides the revenue arm by the output VAT on the same rows.
    const co = await makeCompany('D7V4'); cos.push(co);
    const mixed = await arInvoice(co, '-MIX', '2026-06-15', 1000, 75);
    await arInvoice(co, '-LIVE', '2026-07-20', 2000, 300);
    await file(co, '06');
    await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
        posted_through, locked_by, actor_type)
      VALUES (${co.id}::UUID, '2026-06-01'::date, '2026-06-30'::date, 0, 0, 0, NOW(), ${co.user}, 'human')`;
    await inTx(co, () => softDelete(co.id, 'customer_invoice', mixed, co.user));
    await file(co, '07');

    const recon = await getVatReconciliation(co.id, '2026-06-01', '2026-07-31');
    expect(recon.months.map((m) => [m.month, m.glRevenue, m.glOutputVat, m.outputVatVariance, m.effectiveVatRate]))
      .toEqual([['2026-06', 1000, 75, 0, 7.5], ['2026-07', 2000, 225, 0, 15]]);
    expect(recon.issues.filter((i) => /Effective VAT rate/.test(i.message) && i.month === '2026-07')).toEqual([]);
  }, 180000);

  it('V5 (rev-d7-4b773cdb7): a deleted invoice reversed in its OWN month is no supply of that month', async () => {
    // June is open, so the delete's reversal is dated with the invoice. The
    // pair nets to nothing in June; rating the original alone read 7.5% and
    // flagged a month with no live supplies.
    const co = await makeCompany('D7V5'); cos.push(co);
    const mixed = await arInvoice(co, '-MIX', '2026-06-15', 1000, 75);
    await inTx(co, () => softDelete(co.id, 'customer_invoice', mixed, co.user));

    const recon = await getVatReconciliation(co.id, '2026-06-01', '2026-06-30');
    // The revenue arm still carries the original (the invoice leg does too).
    expect(recon.months.map((m) => [m.month, m.glRevenue, m.revenueVariance, m.glOutputVat, m.effectiveVatRate]))
      .toEqual([['2026-06', 1000, 0, 0, 0]]);
    expect(recon.issues.filter((i) => /Effective VAT rate/.test(i.message))).toEqual([]);
  }, 120000);

  it('V6 (rev-d7-4b773cdb7): a live 15% invoice beside a deleted zero-rated one, same month, reads 15%', async () => {
    const co = await makeCompany('D7V6'); cos.push(co);
    await arInvoice(co, '-LIVE', '2026-06-10', 1000, 150);
    const zero = await arInvoice(co, '-ZERO', '2026-06-15', 1000, 0);
    await inTx(co, () => softDelete(co.id, 'customer_invoice', zero, co.user));

    const recon = await getVatReconciliation(co.id, '2026-06-01', '2026-06-30');
    expect(recon.months.map((m) => [m.month, m.glRevenue, m.revenueVariance, m.glOutputVat, m.effectiveVatRate]))
      .toEqual([['2026-06', 2000, 0, 150, 15]]);
    expect(recon.issues.filter((i) => /Effective VAT rate/.test(i.message))).toEqual([]);
  }, 120000);

  it('the mirror: a LIVE mixed-rate invoice reversed by hand still moves the rate (ledger, unchanged)', async () => {
    const co = await makeCompany('D7V7'); cos.push(co);
    const mixed = await arInvoice(co, '-MIX', '2026-06-15', 1000, 75);
    await arInvoice(co, '-LIVE', '2026-07-20', 2000, 300);
    await reverseTip(co, await journalOf(co, mixed), '2026-07-01');

    const recon = await getVatReconciliation(co.id, '2026-07-01', '2026-07-31');
    expect(recon.months.map((m) => [m.month, m.glRevenue, m.glOutputVat, m.effectiveVatRate]))
      .toEqual([['2026-07', 1000, 225, 22.5]]);
  }, 120000);

  it('KNOWN LIMIT (rev-d7-176b78177): a reversal dated in an EARLIER month than its original leaves the original in the rate', async () => {
    // Only a chain that breaks "no reversal before its original" has this
    // shape: resolveReversalDate refuses it since R-012, so it takes a row
    // written before that, or a fiscal year outside the auto-create window.
    // Forged here by re-dating the delete's reversal. The link is dropped from
    // June (another month from its original), and the original, alone in July
    // beside a live 15% sale, rates July at 11.25% and raises the issue.
    // PINNED, NOT ENDORSED: changing this is fine, but do it on purpose.
    const co = await makeCompany('D7V8'); cos.push(co);
    const mixed = await arInvoice(co, '-MIX', '2026-07-15', 1000, 75);
    await arInvoice(co, '-LIVE', '2026-07-20', 1000, 150);
    await inTx(co, () => softDelete(co.id, 'customer_invoice', mixed, co.user));
    const moved = (await sql`UPDATE gl_journal_entries SET entry_date = '2026-06-10'::date
      WHERE company_id = ${co.id}::UUID AND reversal_of_id = ${await journalOf(co, mixed)}::UUID RETURNING id`) as { id: string }[];
    expect(moved).toHaveLength(1);

    const recon = await getVatReconciliation(co.id, '2026-06-01', '2026-07-31');
    expect(recon.months.map((m) => [m.month, m.glRevenue, m.glOutputVat, m.effectiveVatRate]))
      .toEqual([['2026-06', 0, -75, 0], ['2026-07', 2000, 225, 11.25]]);
    expect(recon.issues.filter((i) => /Effective VAT rate/.test(i.message)).map((i) => i.month)).toEqual(['2026-07']);
  }, 120000);
});
