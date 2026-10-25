/**
 * The export's net VAT IS the return's net VAT, whatever mix of boxes the period holds.
 *
 * Two defects this pins. Box 12 (domestic reverse charge and imported services OUTPUT tax) was in no
 * payload field, so a DRC purchase of 1000 with input 150 and output 150 (net nil) exported net -150, a
 * false refund. And input-side adjustments (16/17/18: bad debts, change in use, other) were ADDED to the
 * net instead of subtracted, so a bad-debt claim of 20 raised the amount payable by 20.
 *
 * The invariant is also enforced in code: a payload whose net differs from the report's refuses with
 * Vat201NetMismatchError. Reports here are synthetic, built the way the real service builds its totals
 * (output tax = sum of output boxes, input tax = sum of input boxes), over a seeded mix of every box kind.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getVat201Report: vi.fn(),
  getCompany: vi.fn(),
  getVatPeriodLock: vi.fn(),
  getVatExceptions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: m.getVat201Report }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: m.getCompany }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({ getVatPeriodLock: m.getVatPeriodLock }));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({ getVatExceptions: m.getVatExceptions }));

import { exportVat201 } from '@/modules/accounting/services/reports/vat201ExportService';
import { buildVAT201Payload, Vat201NetMismatchError } from '@/modules/accounting/services/reports/sarsEfilingService';

type Kind = { box: string; direction: 'output' | 'input'; vatType: string };
const KINDS: Kind[] = [
  { box: '1', direction: 'output', vatType: 'standard' },
  { box: '1A', direction: 'output', vatType: 'capital_goods' },
  { box: '2', direction: 'output', vatType: 'zero_rated' },
  { box: '2A', direction: 'output', vatType: 'export' },
  { box: '3', direction: 'output', vatType: 'exempt' },
  { box: '12', direction: 'output', vatType: 'reverse_charge' },
  { box: '12', direction: 'output', vatType: 'imported' },
  { box: 'unclassified', direction: 'output', vatType: 'unmapped' },
  { box: '14', direction: 'input', vatType: 'capital_goods' },
  { box: '15', direction: 'input', vatType: 'standard' },
  { box: '15', direction: 'input', vatType: 'reverse_charge' },
  { box: '14A/15A', direction: 'input', vatType: 'imported' },
  { box: '17', direction: 'input', vatType: 'bad_debt' },
  { box: '18', direction: 'input', vatType: 'no_vat' },
  { box: 'unclassified', direction: 'input', vatType: 'unmapped' },
];

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Deterministic, so a failure reproduces: mulberry32. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reportFrom(boxes: Array<Kind & { tax: number }>) {
  const full = boxes.map((b) => ({ ...b, label: b.box, base: r2(b.tax / 0.15), impliedTax: 0, variance: 0, lateClaimTax: 0 }));
  const outputTax = r2(full.filter((b) => b.direction === 'output').reduce((s, b) => s + b.tax, 0));
  const inputTax = r2(full.filter((b) => b.direction === 'input').reduce((s, b) => s + b.tax, 0));
  return {
    periodStart: '2026-07-01', periodEnd: '2026-07-31', detail: 'summary', boxes: full, excludedRows: [],
    totals: { outputTax, inputTax, netVat: r2(outputTax - inputTax), standardRatedSupplies: 0, standardRatedPurchases: 0, lateClaimInputTax: 0 },
    rateCheck: { rate: 0.15, outputImpliedTax: 0, outputVariance: 0, inputImpliedTax: 0, inputVariance: 0, ties: true, entriesWithoutBase: [], entriesWithoutBaseTotal: 0 },
    postedThrough: '2026-07-31T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getCompany.mockResolvedValue({ vatNumber: '4123456789', name: 'Acme Ltd' });
  m.getVatPeriodLock.mockResolvedValue(null);
  m.getVatExceptions.mockResolvedValue({
    uncodedGlLineCount: 0, invoiceTaxCodeIssueCount: 0, invoiceGlMismatchCount: 0, vatOnBalanceSheetCount: 0,
    vatNonSupplyCount: 0, unpostedInvoiceVatCount: 0, unsupportedInputVatCount: 0, totalExceptions: 0,
    billTaxCodeWarningCount: 0, billTaxCodeWarningPotentialVat: 0,
  });
});

async function exportedNet(boxes: Array<Kind & { tax: number }>) {
  const report = reportFrom(boxes);
  m.getVat201Report.mockResolvedValue(report);
  const out = await exportVat201('c1', '2026-07-01', '2026-07-31');
  return { net: out.payload!.netVAT, expected: report.totals.netVat };
}

describe('the export payload nets to the report, box by box', () => {
  it('DRC purchase 1000: input 150, output 150, net nil (was +150 before, -150 after the first fix)', async () => {
    const { net, expected } = await exportedNet([
      { box: '15', direction: 'input', vatType: 'reverse_charge', tax: 150 },
      { box: '12', direction: 'output', vatType: 'reverse_charge', tax: 150 },
    ]);
    expect(expected).toBe(0);
    expect(net).toBe(0);
  });

  it('a bad-debt claim of 20 REDUCES the amount payable by 20', async () => {
    const { net, expected } = await exportedNet([
      { box: '1', direction: 'output', vatType: 'standard', tax: 150 },
      { box: '17', direction: 'input', vatType: 'bad_debt', tax: 20 },
    ]);
    expect(expected).toBe(130);
    expect(net).toBe(130);
  });

  it('imported services output tax (box 12) is in the payload', async () => {
    const { net, expected } = await exportedNet([{ box: '12', direction: 'output', vatType: 'imported', tax: 90 }]);
    expect(expected).toBe(90);
    expect(net).toBe(90);
  });

  it('holds over 300 seeded mixes of standard, zero-rated, exempt, export, DRC, imported services, bad debts, capital goods and unmapped boxes', async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = rng(seed);
      const boxes = KINDS.filter(() => next() < 0.45).map((k) => ({ ...k, tax: r2((next() - 0.2) * 5000) }));
      const { net, expected } = await exportedNet(boxes);
      expect(net, `seed ${seed}`).toBeCloseTo(expected, 2);
    }
  });
});

describe('a payload that does not net to the report is refused', () => {
  const data = {
    taxPeriod: '202607', vatNumber: '4123456789', companyName: 'Acme',
    outputVATStandard: 150, outputVATZeroRated: 0, outputVATExempt: 0, inputVATCapitalGoods: 0, inputVATOther: 0, adjustments: 0, outputVATOther: 0,
  };

  it('buildVAT201Payload throws a typed error when its net differs from the expected net', () => {
    const err = (() => { try { buildVAT201Payload(data, { expectedNetVat: 0 }); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(Vat201NetMismatchError);
    expect((err as Vat201NetMismatchError).payloadNet).toBe(150);
    expect((err as Vat201NetMismatchError).expectedNet).toBe(0);
  });

  it('buildVAT201Payload passes when it nets to the expected figure', () => {
    expect(buildVAT201Payload(data, { expectedNetVat: 150 }).netVAT).toBe(150);
  });

  it('exportVat201 refuses a report whose totals disagree with its own boxes', async () => {
    const report = reportFrom([{ box: '1', direction: 'output', vatType: 'standard', tax: 150 }]);
    m.getVat201Report.mockResolvedValue({ ...report, totals: { ...report.totals, netVat: 100 } });
    await expect(exportVat201('c1', '2026-07-01', '2026-07-31')).rejects.toBeInstanceOf(Vat201NetMismatchError);
  });
});
