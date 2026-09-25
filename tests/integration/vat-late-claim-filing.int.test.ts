/**
 * A late-claimed bill is FILED in the claim period, not in the period its
 * invoice is dated in (Hein, 2026-09-25): the document-derived VAT201
 * (generateVAT201 — field 8 and the drill-down) and the pre-filing exceptions
 * that gate eFiling date its VAT by the companion's entry_date. Otherwise the
 * claim period's recon differs by the claimed VAT and evaluateEfilingGate
 * refuses to file it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, draftBill, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture,
} from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: LateFixture;
const docFigures = (start: string, end: string) => inTx(fx, async () => {
  const { outputInvoices: _o, inputInvoices, ...fields } = await generateVAT201(fx.companyId, start, end);
  return { ...fields, inputInvoiceIds: inputInvoices.map((i) => i.id).sort() };
});

let pBeforeLateBill: Awaited<ReturnType<typeof docFigures>>;
let nextBefore: Awaited<ReturnType<typeof getLedgerVAT201>>;
let lateBillId = '';

describeIfDb('late input VAT claim: the claim period files it', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLF', DATABASE_URL!);
    // An ordinary bill in P and one in the claim period, both on time.
    for (const date of ['2026-05-20', '2026-07-15']) {
      const b = await draftBill(fx, date);
      await inTx(fx, () => approveSupplierInvoice(fx.companyId, b.id, fx.userId));
    }
    await lockPeriod(fx, P.start, P.end);
    pBeforeLateBill = await docFigures(P.start, P.end);
    nextBefore = await inTx(fx, () => getLedgerVAT201(fx.companyId, NEXT.start, NEXT.end));
    // The late bill: a SERVICES bill dated in P, approved after P was filed.
    const late = await draftBill(fx, '2026-06-12', { vatClassification: 'services' });
    lateBillId = late.id;
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, late.id, fx.userId, { allowLateInputClaim: true }));
  }, 180000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 120000);

  it('the claim period has no pre-filing exception, and the eFiling gate lets it through', async () => {
    const report = await inTx(fx, () => getVatExceptions(fx.companyId, NEXT.start, NEXT.end));
    expect(report.controlRecon.inputVariance).toBe(0);
    expect(report.invoiceGlMismatches).toEqual([]);
    expect(report.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(report)).toEqual({ allowed: true, reason: null });
  });

  it('fields 8 and 7 of the claim period carry the services bill correctly', async () => {
    const after = await inTx(fx, () => getLedgerVAT201(fx.companyId, NEXT.start, NEXT.end));
    expect(after.field10_totalInputVAT - nextBefore.field10_totalInputVAT).toBeCloseTo(150, 2);
    expect(after.field8_services - nextBefore.field8_services).toBeCloseTo(150, 2);
    expect(after.field7_otherGoods).toBeCloseTo(nextBefore.field7_otherGoods, 2);
    expect(after.inputInvoices.map((i) => i.id)).toContain(lateBillId);
  });

  it('the filed period\'s invoice-based figures are what they were before the late bill existed', async () => {
    expect(await docFigures(P.start, P.end)).toEqual(pBeforeLateBill);
    const pReport = await inTx(fx, () => getVatExceptions(fx.companyId, P.start, P.end));
    expect(pReport.invoiceGlMismatches).toEqual([]);
    expect(pReport.controlRecon.inputVariance).toBe(0);
  });

  it('a genuine bill-vs-GL VAT difference on a late-claimed bill is reported in the claim period, not the filed one', async () => {
    await sql`UPDATE supplier_invoices SET tax_amount = tax_amount + 1 WHERE id = ${lateBillId}::UUID`;
    try {
      const next = await inTx(fx, () => getVatExceptions(fx.companyId, NEXT.start, NEXT.end));
      const p = await inTx(fx, () => getVatExceptions(fx.companyId, P.start, P.end));
      expect(next.invoiceGlMismatches.map((m) => m.invoiceId)).toEqual([lateBillId]);
      expect(p.invoiceGlMismatches).toEqual([]);
    } finally {
      await sql`UPDATE supplier_invoices SET tax_amount = tax_amount - 1 WHERE id = ${lateBillId}::UUID`;
    }
  });

  it('only APPROVED bills count (Hein): a draft in the filed period is not in its field 8, and approving it late moves nothing out', async () => {
    const before = await docFigures(P.start, P.end);
    const draft = await draftBill(fx, '2026-06-25', { vatClassification: 'services' });
    const withDraft = await docFigures(P.start, P.end);
    expect(withDraft).toEqual(before);
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, draft.id, fx.userId, { allowLateInputClaim: true }));
    expect(await docFigures(P.start, P.end)).toEqual(before);
  });
});
