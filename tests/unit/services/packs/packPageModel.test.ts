import { describe, expect, it } from 'vitest';
import {
  assertPageTitleIsAMessage,
  isContentPage,
  type PackDefinition,
  type PackPagesDocument,
  type PackScorecardRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

describe('assertPageTitleIsAMessage', () => {
  it('rejects a bare label', () => {
    // Rubric criterion 1. These are the exact titles the rejected pack shipped.
    for (const bad of ['Financial Ratios', 'Commentary', 'Income Statement', 'Balance Sheet', 'KPI Scorecard']) {
      expect(() => assertPageTitleIsAMessage(bad, 6), bad).toThrow();
    }
  });

  it('accepts a title that states a conclusion about the period', () => {
    expect(() => assertPageTitleIsAMessage(
      'Revenue up 12% but the operating loss widened to R5.8m', 3)).not.toThrow();
  });

  it('exempts the cover, contents and basis pages, which are navigation', () => {
    expect(() => assertPageTitleIsAMessage('Contents', 2)).not.toThrow();
    expect(() => assertPageTitleIsAMessage('Basis of preparation and definitions', 12)).not.toThrow();
  });

  // R-P30: the exemption covers four spec-mandated cases, not two. Page 1's
  // title is the company's legal name — arbitrary text, data we do not
  // choose, exempted by NUMBER — and 'Matters requiring board attention'
  // (page 11) joins the exact-match navigation set.
  it('exempts page 1 by number, whatever its title reads', () => {
    expect(() => assertPageTitleIsAMessage('Velocity Fibre (Pty) Ltd', 1)).not.toThrow();
  });

  it('exempts the exact navigation title for page 11', () => {
    expect(() => assertPageTitleIsAMessage('Matters requiring board attention', 11)).not.toThrow();
  });
});

describe('isContentPage', () => {
  it('excludes the cover and contents from the density rule', () => {
    expect(isContentPage(1)).toBe(false);
    expect(isContentPage(2)).toBe(false);
    expect(isContentPage(3)).toBe(true);
  });
});

// Fix round 1: three Critical spec gaps found by blind review, each a field
// the spec mandates that the model did not declare. These pin the new/widened
// types — a type has no runtime existence, so removing the field from the
// interface fails `bun run type-check`, which is how these fixtures "go red".
describe('type pins — fix round 1 Criticals', () => {
  it('PackPagesDocument carries numberConvention and basisOfPreparation (Critical 1 / R-P34)', () => {
    const doc: PackPagesDocument = {
      packType: 'board',
      packLabel: 'Board Pack',
      companyName: 'Velocity Fibre (Pty) Ltd',
      period: 'August 2026',
      generatedAt: '2026-09-07T00:00:00.000Z',
      draft: false,
      brand: {
        primaryColour: '#123456',
        secondaryColour: '#c8a86b',
        logoUrl: null,
        footerText: null,
        primaryInk: '#ffffff',
      },
      numberConvention: { scale: "R'000", currency: 'ZAR' },
      basisOfPreparation: {
        standard: 'IFRS for SMEs',
        sourceSystem: 'IsaFlow general ledger',
        extractedAt: '2026-09-06T23:50:00.000Z',
        ledgerVersion: 'gl@969758b4',
      },
      provenance: new PackFigureProvenance(),
      pages: [],
    };
    expect(doc.numberConvention.scale).toBe("R'000");
    expect(doc.numberConvention.currency).toBe('ZAR');
    expect(doc.basisOfPreparation.standard).toBe('IFRS for SMEs');
    expect(doc.basisOfPreparation.ledgerVersion).toBe('gl@969758b4');
  });

  it('PackDefinition carries an optional reconciliation bridge (Critical 2)', () => {
    const definition: PackDefinition = {
      term: 'Adjusted net profit',
      definition: 'Net profit after adding back once-off, non-recurring items.',
      reconciliation: [
        {
          label: 'IFRS net profit',
          figure: { value: 4_200_000, format: 'money', source: 'getFinancialFigures.period.netProfit' },
        },
        {
          label: 'Add back: once-off restructuring costs',
          figure: { value: 300_000, format: 'money', source: 'getAdjustments.period.restructuring' },
        },
        {
          label: 'Adjusted net profit',
          figure: { value: 4_500_000, format: 'money', source: 'packAdjustedMeasures.period.adjustedNetProfit' },
        },
      ],
    };
    expect(definition.reconciliation).toHaveLength(3);
    expect(definition.reconciliation?.[2]?.figure.value).toBe(4_500_000);
  });

  it('leaves PackDefinition.reconciliation optional for a plain IFRS term', () => {
    const definition: PackDefinition = {
      term: 'Revenue',
      definition: 'Income from ordinary operations.',
    };
    expect(definition.reconciliation).toBeUndefined();
  });

  it('PackScorecardRow carries a typed Trend column, distinct from bulletSvg (Critical 3)', () => {
    const row: PackScorecardRow = {
      metric: 'Gross margin',
      actual: { value: 42.5, format: 'pct', source: 'r.grossMargin' },
      target: 40,
      prior: { value: 39.1, format: 'pct', source: 'r.grossMargin' },
      status: 'met',
      trend: 'up',
      trendSvg: '<svg>trend arrow</svg>',
      bulletSvg: '<svg>bullet gauge</svg>',
    };
    expect(row.trend).toBe('up');
    expect(row.trendSvg).not.toBe(row.bulletSvg);
  });
});
