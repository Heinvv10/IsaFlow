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
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { type Co, makeCompany, cleanup, inTx, arInvoice, apBill, journalOf, reverseTip } from './k053-chain.helpers';

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
  beforeAll(() => { assertDisposable(); });
  afterAll(async () => { for (const c of cos) await cleanup(c); }, 120000);

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

  it('V3: the effective VAT rate divides the ledger\'s VAT by the ledger\'s revenue', async () => {
    // August carries a live sale AND a deleted document's R2. The revenue arm
    // leaves R2 out (the invoice leg never had it); its VAT is in the ledger.
    // Rated on the revenue arm, August read 30% and raised a false issue.
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
});
