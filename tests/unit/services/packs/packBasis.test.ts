import { describe, expect, it } from 'vitest';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
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
    // A real charge, so EBITDA's bridge exercises the add-back rather than a
    // nil one any implementation would satisfy.
    depreciation: 24_000,
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

const doc = { draft: false, generatedAt: '2026-02-01T00:00:00.000Z' };

describe('buildBasis', () => {
  // R-P46: ledgerVersion is a VALUE the caller supplies (typically
  // getLedgerPostedThrough's result), never read off set.budget — a budget's
  // postedThrough is null for any company with no budget, and even when
  // present it answers a different question ("when was the budget variance
  // last posted through", not "what ledger state did THIS pack render
  // against"). Both branches are pinned so an always-unavailable
  // implementation cannot pass silently.
  it('renders a supplied ledger version', () => {
    const basis = buildBasis(setWith(), doc, '2026-01-31T10:00:00.000Z', new PackFigureProvenance());
    // IN WORDS, ON THE COMPANY'S CLOCK. The page printed the raw ISO-8601 to
    // the millisecond in UTC, on a document whose every other date is set in
    // words — and 10:00Z is 12:00 to everyone who reads it.
    expect(basis.basisOfPreparation.ledgerVersion).toBe('31 January 2026 at 12:00 SAST');
  });

  it('states the gap explicitly, never a blank or an invented identifier, when no ledger version is supplied', () => {
    const basis = buildBasis(setWith(), doc, null, new PackFigureProvenance());
    expect(basis.basisOfPreparation.ledgerVersion).toMatch(/unavailable/i);
    expect(basis.basisOfPreparation.ledgerVersion).not.toBe('');
    expect(basis.basisOfPreparation.ledgerVersion).not.toBe(doc.generatedAt);
  });

  it('does not fall back to the budget watermark when no ledger version is supplied', () => {
    const set = setWith({
      budget: {
        fiscalYear: 2026,
        totals: { budget: 0, actual: 0, variance: 0 },
        rows: [{ accountCode: '1', accountName: 'a', accountType: 'revenue', budget: 0, actual: 0, variance: 0, variancePct: 0 }],
        postedThrough: '2026-01-31T10:00:00.000Z',
      },
    });
    const basis = buildBasis(set, doc, null, new PackFigureProvenance());
    expect(basis.basisOfPreparation.ledgerVersion).not.toBe('2026-01-31T10:00:00.000Z');
    expect(basis.basisOfPreparation.ledgerVersion).toMatch(/unavailable/i);
  });

  it('surfaces classificationCaveat and inventoryCaveat as basis-page caveats, never suppressing a ratio', () => {
    const set = setWith({
      current: figures({
        classificationCaveat: 'Some subtypes were unclassified and defaulted to current.',
        inventoryCaveat: 'No inventory could be identified in the chart of accounts.',
      }),
    });
    const basis = buildBasis(set, doc, 'v1', new PackFigureProvenance());
    expect(basis.caveats).toContain('Some subtypes were unclassified and defaulted to current.');
    expect(basis.caveats).toContain('No inventory could be identified in the chart of accounts.');
  });

  it('omits a caveat that is not present rather than emitting an empty one', () => {
    const set = setWith({ current: figures({ classificationCaveat: null, inventoryCaveat: null }) });
    const basis = buildBasis(set, doc, 'v1', new PackFigureProvenance());
    expect(basis.caveats).toHaveLength(0);
  });

  it('flags a draft pack in the caveats', () => {
    const basis = buildBasis(setWith(), { ...doc, draft: true }, 'v1', new PackFigureProvenance());
    expect(basis.caveats.some((c) => /draft/i.test(c))).toBe(true);
  });

  it('defines every non-IFRS measure the pack prints, and reconciles the one that needs it', () => {
    const basis = buildBasis(setWith(), doc, 'v1', new PackFigureProvenance());
    const terms = basis.definitions.map((d) => d.term);
    // Page 12 defined four terms while the pack printed ten more, EBITDA
    // among them — the measure an audit committee chair asks about first,
    // printed identical to operating profit with nothing to say whether
    // depreciation was nil or the measure unimplemented.
    for (const term of [
      'EBITDA', 'Working capital', 'Debtor days', 'Creditor days', 'Cash ratio',
      'Debt-to-equity', 'Interest cover', 'Cash conversion cycle', 'Operating margin',
    ]) {
      expect(terms, `${term} is printed by the pack and not defined`).toContain(term);
    }

    for (const def of basis.definitions) {
      if (def.reconciliation) expect(def.reconciliation.length).toBeGreaterThan(0);
    }

    // AND THE BRIDGE ADDS UP. A reconciliation a reader cannot foot is a
    // decoration; this is the whole reason it is FIGURES rather than prose.
    const bridge = basis.definitions.find((d) => d.term === 'EBITDA')!.reconciliation!;
    expect(bridge).toHaveLength(3);
    const [operating, addBack, ebitda] = bridge.map((step) => step.figure.value!);
    expect(operating + addBack).toBeCloseTo(ebitda, 2);
    // Mutation-proof: the fixture charges depreciation, so an implementation
    // that dropped the add-back would still foot if the charge were nil.
    expect(addBack).toBeGreaterThan(0);
  });

  it('states the standard, source system and currency the whole pack rests on', () => {
    const basis = buildBasis(setWith(), doc, 'v1', new PackFigureProvenance());
    expect(basis.basisOfPreparation.standard).toBe('IFRS for SMEs');
    expect(basis.basisOfPreparation.sourceSystem).toBe('IsaFlow general ledger');
    expect(basis.basisOfPreparation.extractedAt).toBe('1 February 2026 at 02:00 SAST');
    expect(basis.numberConvention.currency).toBe('ZAR');
  });
});
