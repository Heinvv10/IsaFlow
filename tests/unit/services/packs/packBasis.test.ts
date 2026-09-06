import { describe, expect, it } from 'vitest';
import { buildBasis } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';

function figures(overrides: Partial<ReportPackFigures> = {}): ReportPackFigures {
  return {
    companyName: 'Test Co',
    period: '2026-01-01 to 2026-01-31',
    revenue: 1_000_000,
    costOfSales: 600_000,
    operatingExpenses: 250_000,
    otherIncome: 0,
    otherExpenses: 0,
    operatingProfit: 150_000,
    netProfit: 120_000,
    totalAssets: 900_000,
    totalLiabilities: 300_000,
    totalEquity: 600_000,
    currentAssets: 400_000,
    currentLiabilities: 200_000,
    cash: 150_000,
    accountsReceivable: 90_000,
    accountsPayable: 60_000,
    inventory: 50_000,
    inventoryCaveat: null,
    classificationCaveat: null,
    ...overrides,
  };
}

function setWith(overrides: Partial<PackFigureSet> = {}): PackFigureSet {
  return {
    current: figures(),
    currentWindow: { start: '2026-01-01', end: '2026-01-31' },
    prior: null,
    priorWindow: { start: '2025-12-01', end: '2025-12-31' },
    budget: null,
    ...overrides,
  };
}

describe('buildBasis', () => {
  it('reads the ledger version off the budget watermark when a budget exists', () => {
    const set = setWith({
      budget: {
        fiscalYear: 2026,
        totals: { budget: 0, actual: 0, variance: 0 },
        rows: [{ accountCode: '1', accountName: 'a', accountType: 'revenue', budget: 0, actual: 0, variance: 0, variancePct: 0 }],
        postedThrough: '2026-01-31T10:00:00.000Z',
      },
    });
    const basis = buildBasis(set, { draft: false, generatedAt: '2026-02-01T00:00:00.000Z' });
    expect(basis.basisOfPreparation.ledgerVersion).toBe('2026-01-31T10:00:00.000Z');
  });

  it('states the gap plainly rather than passing generatedAt off as a ledger watermark when there is no budget', () => {
    const set = setWith({ budget: null });
    const basis = buildBasis(set, { draft: false, generatedAt: '2026-02-01T00:00:00.000Z' });
    expect(basis.basisOfPreparation.ledgerVersion).not.toBe('2026-02-01T00:00:00.000Z');
    expect(basis.basisOfPreparation.ledgerVersion).toMatch(/unavailable/i);
  });

  it('surfaces classificationCaveat and inventoryCaveat as basis-page caveats, never suppressing a ratio', () => {
    const set = setWith({
      current: figures({
        classificationCaveat: 'Some subtypes were unclassified and defaulted to current.',
        inventoryCaveat: 'No inventory could be identified in the chart of accounts.',
      }),
    });
    const basis = buildBasis(set, { draft: false, generatedAt: '2026-02-01T00:00:00.000Z' });
    expect(basis.caveats).toContain('Some subtypes were unclassified and defaulted to current.');
    expect(basis.caveats).toContain('No inventory could be identified in the chart of accounts.');
  });

  it('omits a caveat that is not present rather than emitting an empty one', () => {
    const set = setWith({ current: figures({ classificationCaveat: null, inventoryCaveat: null }) });
    const basis = buildBasis(set, { draft: false, generatedAt: '2026-02-01T00:00:00.000Z' });
    expect(basis.caveats).toHaveLength(0);
  });

  it('flags a draft pack in the caveats', () => {
    const basis = buildBasis(setWith(), { draft: true, generatedAt: '2026-02-01T00:00:00.000Z' });
    expect(basis.caveats.some((c) => /draft/i.test(c))).toBe(true);
  });

  it('carries no unreconciled non-IFRS measure — every definition either has a reconciliation or needs none', () => {
    const basis = buildBasis(setWith(), { draft: false, generatedAt: '2026-02-01T00:00:00.000Z' });
    expect(basis.definitions.length).toBeGreaterThan(0);
    for (const def of basis.definitions) {
      // None of the currently-defined terms are adjusted dollar measures, so
      // none carries a reconciliation. The moment one does, it must be a
      // non-empty bridge — spec §7.1 criterion 12 — not an empty array.
      if (def.reconciliation) expect(def.reconciliation.length).toBeGreaterThan(0);
    }
  });

  it('states the standard, source system and currency the whole pack rests on', () => {
    const basis = buildBasis(setWith(), { draft: false, generatedAt: '2026-02-01T00:00:00.000Z' });
    expect(basis.basisOfPreparation.standard).toBe('IFRS for SMEs');
    expect(basis.basisOfPreparation.sourceSystem).toBe('IsaFlow general ledger');
    expect(basis.basisOfPreparation.extractedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(basis.numberConvention.currency).toBe('ZAR');
  });
});
