/**
 * The twelve-page board pack, composed.
 *
 * Two fixtures, and the second is the one that matters. `demoInput` is a
 * healthy company with a prior period and a budget — it can only ever
 * exercise the happy path, so on its own it would leave every null-prior and
 * null-budget branch in this pack unreached. `brightsphereInput` mirrors the
 * real client: negative revenue, negative equity, no prior period, no budget.
 *
 * The block-content assertions exist because "at least three blocks" passes
 * trivially on three EMPTY blocks. A page carrying an empty table, an empty
 * tile strip and an unapproved narrative satisfies the count and ships a
 * blank page, which is the defect spec §5.7 names.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  assertPageTitleIsAMessage,
  type PackPageBlock,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';

function figures(overrides: Partial<ReportPackFigures>): ReportPackFigures {
  return {
    companyName: 'ISAFlow Demo (Pty) Ltd',
    period: '2026-03-01 to 2026-08-31',
    revenue: 4_200_000,
    costOfSales: 2_310_000,
    operatingExpenses: 1_180_000,
    otherIncome: 40_000,
    otherExpenses: 15_000,
    operatingProfit: 735_000,
    netProfit: 512_000,
    totalAssets: 3_900_000,
    totalLiabilities: 1_640_000,
    totalEquity: 2_260_000,
    currentAssets: 1_850_000,
    currentLiabilities: 940_000,
    cash: 610_000,
    accountsReceivable: 720_000,
    accountsPayable: 430_000,
    inventory: 310_000,
    operatingCashFlow: 690_000,
    capitalExpenditure: 180_000,
    financingCashFlow: -120_000,
    inventoryCaveat: null,
    classificationCaveat: null,
    ...overrides,
  };
}

const trend: PackTrendPoint[] = Array.from({ length: 13 }, (_, i) => ({
  month: `2025-${String(i + 1).padStart(2, '0')}`,
  label: `M${i + 1}`,
  revenue: 600_000 + i * 12_000,
  expenses: 520_000 + i * 9_000,
  netProfit: 80_000 + i * 3_000,
}));

const brand: PackBrand = {
  primaryColour: '#1f4e79',
  secondaryColour: '#c8a86b',
  logoUrl: null,
  footerText: null,
  primaryInk: '#ffffff',
};

const matters: PackMatter[] = [
  {
    issue: 'Aged debtor concentration: Acme Holdings is 34.0% of total debtors owed',
    quantum: 244_800,
    owner: 'Credit control',
    movement: 'Not tracked — no prior board pack is stored to compare against.',
    decisionRequired: 'Approve escalation, a credit hold, or a write-off review for this account.',
  },
];

const demoSet: PackFigureSet = {
  current: figures({}),
  currentWindow: { start: '2026-03-01', end: '2026-08-31' },
  prior: figures({
    revenue: 3_750_000,
    costOfSales: 2_100_000,
    operatingExpenses: 1_090_000,
    operatingProfit: 560_000,
    netProfit: 388_000,
    totalAssets: 3_540_000,
    totalLiabilities: 1_580_000,
    totalEquity: 1_960_000,
    currentAssets: 1_690_000,
    currentLiabilities: 900_000,
    cash: 486_000,
    accountsReceivable: 660_000,
    accountsPayable: 410_000,
    inventory: 295_000,
    operatingCashFlow: 540_000,
    capitalExpenditure: 150_000,
    financingCashFlow: -90_000,
  }),
  priorWindow: { start: '2025-09-01', end: '2026-02-28' },
  budget: {
    fiscalYear: 2026,
    totals: { budget: 4_000_000, actual: 4_200_000, variance: 200_000 },
    rows: [
      {
        accountCode: '1000',
        accountName: 'Sales',
        accountType: 'revenue',
        budget: 4_000_000,
        actual: 4_200_000,
        variance: 200_000,
        variancePct: 5,
      },
    ],
    postedThrough: '2026-08-31',
  },
};

const demoInput: BoardPackInput = {
  companyLegalName: 'ISAFlow Demo (Pty) Ltd',
  period: '1 March 2026 to 31 August 2026',
  generatedAt: '2026-09-07T06:00:00.000Z',
  draft: false,
  preparedBy: 'Finance',
  brand,
  set: demoSet,
  trend,
  matters,
  commentary: {
    status: 'approved',
    body: 'Trading held up through the winter and the operating line improved.',
    actions: ['Approve the revised debtor policy.'],
  },
  mattersCommentary: {
    status: 'approved',
    body: 'One concentration matter carries forward from the last meeting.',
    actions: [],
  },
  ledgerVersion: 'posted-through 2026-08-31',
};

/**
 * Brightsphere: negative revenue, negative equity, no prior, no budget, and
 * no approved commentary on either narrative page.
 */
const brightsphereSet: PackFigureSet = {
  current: figures({
    companyName: 'Brightsphere (Pty) Ltd',
    revenue: -5_535_000,
    costOfSales: 0,
    operatingExpenses: -3_717_000,
    otherIncome: 0,
    otherExpenses: 0,
    operatingProfit: -1_818_000,
    netProfit: -1_818_000,
    totalAssets: 200_000,
    totalLiabilities: 450_000,
    totalEquity: -250_000,
    currentAssets: 100_000,
    currentLiabilities: 380_000,
    cash: 12_000,
    accountsReceivable: 64_000,
    accountsPayable: 210_000,
    inventory: 0,
    operatingCashFlow: -95_000,
    capitalExpenditure: 0,
    financingCashFlow: 0,
    inventoryCaveat: 'No inventory accounts are classified, so a quick ratio has not excluded any.',
    classificationCaveat: null,
  }),
  currentWindow: { start: '2026-03-01', end: '2026-08-31' },
  prior: null,
  priorWindow: { start: '2025-09-01', end: '2026-02-28' },
  budget: null,
};

const brightsphereInput: BoardPackInput = {
  ...demoInput,
  companyLegalName: 'Brightsphere (Pty) Ltd',
  set: brightsphereSet,
  trend: [],
  matters: [
    {
      issue: 'No matters require board attention this period — every check ran clean.',
      quantum: null,
      owner: 'Finance',
      movement: 'Not tracked — no prior board pack is stored to compare against.',
      decisionRequired: 'None. Note for the record.',
    },
  ],
  commentary: null,
  mattersCommentary: null,
  ledgerVersion: null,
};

/** Whether a block puts anything on the page. Counting blocks is not enough. */
function blockHasContent(block: PackPageBlock): boolean {
  switch (block.kind) {
    case 'kpiTiles':
      return block.tiles.length > 0;
    case 'statTiles':
      return block.groups.length > 0 && block.groups.every((g) => g.stats.length > 0);
    case 'table':
      return block.table.rows.length > 0 && block.table.columns.length > 0;
    case 'scorecard':
      return block.groups.length > 0 && block.groups.every((g) => g.rows.length > 0);
    case 'chart':
      return block.chart.svg.length > 0;
    case 'smallMultiples':
      return block.panels.length > 0 && block.panels.every((p) => p.svg.length > 0);
    case 'narrative':
      // A 'pending' narrative renders a visible placeholder (NarrativeColumns);
      // a 'draft' one renders literally nothing and is never page content.
      return block.narrative.status === 'pending'
        ? true
        : block.narrative.status === 'approved' && (block.narrative.body ?? '').trim() !== '';
    case 'disclosure':
      return block.disclosure.notes.length > 0
        && block.disclosure.notes.every((n) => n.body.trim() !== '');
    case 'definitions':
      return block.entries.length > 0;
  }
}

describe('buildBoardPackPages', () => {
  const doc = buildBoardPackPages(demoInput);

  it('is exactly twelve pages, numbered 1..12', () => {
    expect(doc.pages.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('titles every content page with a message', () => {
    for (const page of doc.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number), `page ${page.number}`).not.toThrow();
    }
  });

  it('gives every page its own title — no two pages say the same thing', () => {
    const titles = doc.pages.map((p) => p.title);
    expect(new Set(titles).size).toBe(12);
  });

  it('puts a chart on the results, position, cash and trends pages', () => {
    for (const n of [6, 7, 8, 10]) {
      const page = doc.pages.find((p) => p.number === n)!;
      expect(page.blocks.some((b) => b.kind === 'chart' || b.kind === 'smallMultiples'), `page ${n}`).toBe(true);
    }
  });

  it('gives every content page at least three blocks', () => {
    for (const page of doc.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('puts content in every block it emits, on both fixtures', () => {
    for (const source of [doc, buildBoardPackPages(brightsphereInput)]) {
      for (const page of source.pages) {
        for (const block of page.blocks) {
          expect(blockHasContent(block), `page ${page.number} block ${block.kind}`).toBe(true);
        }
      }
    }
  });

  it('keeps the narrative page free of tabular figures, per spec §4.A page 4', () => {
    const page = doc.pages.find((p) => p.number === 4)!;
    expect(page.blocks.every((b) => b.kind === 'narrative')).toBe(true);
    expect(page.blocks.length).toBeGreaterThan(0);
  });

  it('renders the trends page landscape and every other page portrait', () => {
    expect(doc.pages.find((p) => p.number === 10)?.orientation).toBe('landscape');
    expect(doc.pages.filter((p) => p.orientation === 'landscape')).toHaveLength(1);
  });

  it('shows a comparative on every KPI and every statement row that has one', () => {
    const tiles = doc.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    expect(tiles.length).toBe(8);
    expect(tiles.every((t) => t.delta !== null)).toBe(true);
  });

  it('states the comparison basis on every delta it prints', () => {
    const tiles = doc.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    expect(tiles.every((t) => (t.delta?.basis ?? '').trim() !== '')).toBe(true);
  });

  it('carries the prior column on the statement tables when there is a prior period', () => {
    for (const n of [5, 6, 7, 8]) {
      const tables = doc.pages.find((p) => p.number === n)!.blocks
        .flatMap((b) => (b.kind === 'table' ? [b.table] : []));
      expect(tables.length, `page ${n}`).toBeGreaterThan(0);
      expect(tables.every((t) => t.columns.includes('prior')), `page ${n}`).toBe(true);
    }
  });

  it('renders the supplied ledger version on the basis page, not an invented one', () => {
    expect(doc.basisOfPreparation.ledgerVersion).toBe('posted-through 2026-08-31');
  });

  it('survives a company with no prior period, no budget and negative revenue', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(doc2.pages).toHaveLength(12);
    for (const page of doc2.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number), `page ${page.number}`).not.toThrow();
    }
    for (const page of doc2.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('fabricates no comparative for a company with no prior period', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    for (const page of doc2.pages) {
      for (const block of page.blocks) {
        if (block.kind === 'table') {
          for (const column of ['prior', 'change', 'changePct'] as const) {
            expect(block.table.columns.includes(column), `page ${page.number} ${column}`).toBe(false);
          }
        }
        if (block.kind === 'kpiTiles') {
          expect(block.tiles.every((t) => t.delta === null), `page ${page.number}`).toBe(true);
        }
        if (block.kind === 'scorecard') {
          expect(block.groups.flatMap((g) => g.rows).every((r) => r.prior === null)).toBe(true);
        }
      }
    }
  });

  it('states the ledger version is unavailable rather than inventing one', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(doc2.basisOfPreparation.ledgerVersion).toMatch(/unavailable/i);
  });

  it('renders a visible pending placeholder where commentary is not approved', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    for (const n of [4, 11]) {
      const narratives = doc2.pages.find((p) => p.number === n)!.blocks
        .flatMap((b) => (b.kind === 'narrative' ? [b.narrative] : []));
      expect(narratives.length, `page ${n}`).toBeGreaterThan(0);
      expect(narratives.some((x) => x.status === 'pending'), `page ${n}`).toBe(true);
      expect(narratives.every((x) => x.status !== 'draft'), `page ${n}`).toBe(true);
    }
  });

  it('records every figure it renders in the provenance map', () => {
    expect(() => doc.provenance.assertConsistent()).not.toThrow();
    expect([...doc.provenance.all().keys()].length).toBeGreaterThan(30);
  });

  it('keeps the provenance of the hostile case consistent too', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(() => doc2.provenance.assertConsistent()).not.toThrow();
    expect([...doc2.provenance.all().keys()].length).toBeGreaterThan(30);
  });
});
