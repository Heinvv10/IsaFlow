/**
 * Owner's decision (Hein, 2026-09-27): the VAT pre-filing gate blocks only
 * where the return's figures could be wrong in SARS's favour AGAINST THE
 * VENDOR. A record problem that can only mean a vendor claimed LESS input
 * VAT than a bill's own rate supports — never more — is a warning, not a
 * blocking exception.
 *
 *   NOT blocking — a SUPPLIER bill with a tax rate but zero VAT recorded, or
 *   with no tax rate at all: `billTaxCodeWarnings` (with the bill's potential
 *   input VAT at its own rate), excluded from `totalExceptions`. Locking,
 *   mark-submitted and eFiling all proceed with no override needed.
 *
 *   STILL blocking — the same record problem on a CUSTOMER invoice can only
 *   mean under-declared output VAT, so `invoiceTaxCodeIssues` is unchanged.
 *
 * This file pins both directions end-to-end: getVatExceptions' lists and
 * totalExceptions, evaluateEfilingGate, and assertVatGateClear for BOTH
 * 'vat_period_lock' and 'sars_submission' targets, WITHOUT an override.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { assertVatGateClear, VatGateBlockedError } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;

const S = '2026-09-01';
const E = '2026-09-30';
const report = () => inTx(fx, () => getVatExceptions(fx.companyId, S, E));
const actor = () => ({ userId: fx.userId, role: 'owner' as const });

async function setBillTax(id: string, taxRate: number | null, taxAmount: number, subtotal: number): Promise<void> {
  await sql`UPDATE supplier_invoices SET subtotal = ${subtotal}, tax_rate = ${taxRate}, tax_amount = ${taxAmount},
    total_amount = ${subtotal + taxAmount} WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
}

async function setInvoiceTax(id: string, taxRate: number | null, taxAmount: number, subtotal: number): Promise<void> {
  await sql`UPDATE customer_invoices SET subtotal = ${subtotal}, tax_rate = ${taxRate}, tax_amount = ${taxAmount},
    total_amount = ${subtotal + taxAmount} WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
}

describeIfDb('supplier bill tax-code issues are a warning, not a block (Hein, 2026-09-27)', () => {
  beforeAll(async () => {
    assertNotProductionDb('vat-bill-taxcode-warn');
    fx = await seedFixture('VBW', DATABASE_URL!);
  }, 180000);

  afterAll(async () => { if (fx) await dropFixture(fx); }, 120000);

  it('a bill with a rate but zero VAT: not blocking, gate allows, lock and mark-submitted succeed without override', async () => {
    const bill = await seedBill(fx, { number: 'RATE-NO-VAT', date: '2026-09-05', total: 2000, status: 'approved' });
    await setBillTax(bill, 15, 0, 2000);

    const r = await report();
    expect(r.invoiceTaxCodeIssues).toEqual([]);
    expect(r.invoiceTaxCodeIssueCount).toBe(0);
    const warning = r.billTaxCodeWarnings.find((w) => w.invoiceId === bill);
    expect(warning).toMatchObject({ issue: 'rate_without_vat', taxRate: 15, subtotal: 2000, potentialInputVat: 300 });
    expect(r.billTaxCodeWarningCount).toBe(1);
    expect(r.billTaxCodeWarningPotentialVat).toBe(300);
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });

    const lock = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'vat_period_lock', null, actor(), undefined));
    expect(lock).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
    const submit = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'sars_submission', null, actor(), undefined));
    expect(submit).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
  });

  it('a bill with tax_rate NULL: also not blocking, potential VAT is 0 (no rate to compute against)', async () => {
    const bill = await seedBill(fx, { number: 'NO-RATE', date: '2026-09-06', total: 1000, status: 'approved' });
    await setBillTax(bill, null, 0, 1000);

    const r = await report();
    const warning = r.billTaxCodeWarnings.find((w) => w.invoiceId === bill);
    expect(warning).toMatchObject({ issue: 'missing_tax_rate', taxRate: null, potentialInputVat: 0 });
    // Cumulative with the previous test's rate_without_vat bill — both are warnings.
    expect(r.billTaxCodeWarningCount).toBe(2);
    expect(r.invoiceTaxCodeIssueCount).toBe(0);
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });

    const lock = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'vat_period_lock', null, actor(), undefined));
    expect(lock).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
    const submit = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'sars_submission', null, actor(), undefined));
    expect(submit).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
  });

  it('billTaxCodeWarningPotentialVat foots to the cent against the rows shown (PR #546 review)', async () => {
    // Three bills whose per-row VAT doesn't divide cleanly to the cent:
    // 33.33 * 10% = 3.333 each, which rounds DOWN to 3.33 per row (sum of
    // rounded rows: 9.99). Summing the three UNROUNDED values first (9.999)
    // and rounding ONCE (the old, buggy SQL) instead rounds UP to 10.00 —
    // one cent more than the true sum of the three displayed rows. The fix
    // sums each row's OWN rounded value in SQL (matching
    // mapBillTaxCodeWarning's per-row rounding), so the total foots.
    const bills = await Promise.all([
      seedBill(fx, { number: 'ROUND-1', date: '2026-09-08', total: 33.33, status: 'approved' }),
      seedBill(fx, { number: 'ROUND-2', date: '2026-09-08', total: 33.33, status: 'approved' }),
      seedBill(fx, { number: 'ROUND-3', date: '2026-09-08', total: 33.33, status: 'approved' }),
    ]);
    await Promise.all(bills.map((id) => setBillTax(id, 10, 0, 33.33)));

    const r = await report();
    const rows = r.billTaxCodeWarnings.filter((w) => bills.includes(w.invoiceId));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.potentialInputVat).toBe(3.33);

    // The reported total across ALL warnings in the period must foot to the
    // cent against the sum of every row it counts (the SQL's own
    // ROUND(per-row, 2) then SUM — the same expression the mapper uses —
    // rather than SUM(unrounded) rounded once, which can differ by a cent).
    const sumOfAllRows = Math.round(r.billTaxCodeWarnings.reduce((s, w) => s + w.potentialInputVat, 0) * 100) / 100;
    expect(r.billTaxCodeWarningPotentialVat).toBe(sumOfAllRows);
  });

  it('the SAME record problem on a customer invoice STILL blocks — no override', async () => {
    const invoice = await seedInvoice(fx, { number: 'CI-RATE-NO-VAT', date: '2026-09-07', total: 500, status: 'sent' });
    await setInvoiceTax(invoice, 15, 0, 500);

    const r = await report();
    const issue = r.invoiceTaxCodeIssues.find((i) => i.invoiceId === invoice);
    expect(issue).toMatchObject({ invoiceKind: 'customer', issue: 'rate_without_vat', taxRate: 15 });
    expect(r.invoiceTaxCodeIssueCount).toBeGreaterThanOrEqual(1);
    expect(r.totalExceptions).toBeGreaterThanOrEqual(1);
    expect(evaluateEfilingGate(r).allowed).toBe(false);

    await expect(
      inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'vat_period_lock', null, actor(), undefined)),
    ).rejects.toBeInstanceOf(VatGateBlockedError);
    await expect(
      inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'sars_submission', null, actor(), undefined)),
    ).rejects.toBeInstanceOf(VatGateBlockedError);
  });
});
