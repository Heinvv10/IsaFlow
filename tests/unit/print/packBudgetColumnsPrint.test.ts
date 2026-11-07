/**
 * Budgets P3 PR-E, printed: page 6 of a pack whose company has a budget carries Budget and
 * Variance, eight data columns where it had six. Proven on paper, not on the model: the real
 * print stylesheet, Chromium's PDF and its text layer (`printBoardPack`). Nothing may run past
 * the paper's right edge, the two headings must be on the income statement's sheet, and every
 * budget figure must print whole (a cell too narrow for it wraps the figure across two lines).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { formatStatementFigure, MONEY_SCALES } from '@/lib/format/money';
import { BUDGET_COLUMNS_DROPPED_NOTE as DROPPED_NOTE } from '@/modules/accounting/services/packs/pages/packIncomeBudget';
import { demoInput, demoSet } from '../services/packs/fixtures/boardPackInputs';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/packBoardPackInput';
import { printBoardPack, type PrintedPack } from './renderPackPdf';

let browser: Browser;
let printed: PrintedPack;
const doc = buildBoardPackPages(demoInput);

beforeAll(async () => {
  browser = await launchPrintChromium();
  printed = await printBoardPack(doc, browser);
}, 180_000);
afterAll(async () => { await browser?.close(); });

/** The sheet the income statement printed on: the one carrying its rows. */
const incomeSheet = (from: PrintedPack = printed): string => {
  const sheet = from.sheetText.find((t) => /Gross profit/.test(t) && /Operating expenses/.test(t) && /Net profit/.test(t));
  if (!sheet) throw new Error('no printed sheet carries the income statement');
  return sheet.replace(/ /g, ' ');
};
/** Whitespace-collapsed, so a note wrapped across lines still matches and an absence check cannot pass on a wrap. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('page 6 with a budget, on paper', () => {
  it('runs past no page edge', () => {
    expect(printed.overflow).toEqual([]);
  });

  it('heads the two columns on the income statement sheet', () => {
    expect(incomeSheet()).toMatch(/budget/i);
    expect(incomeSheet()).toMatch(/variance/i);
  });

  it('prints every budget figure whole', () => {
    const scale = "R'000" as const;
    expect(MONEY_SCALES[scale]).toBe(1000);
    for (const [key, value] of Object.entries(demoSet.budget!.bands)) {
      const text = formatStatementFigure(value as number, { scale, pack: true }).replace(/ /g, ' ');
      expect(incomeSheet(), `${key} budget ${text}`).toContain(text);
    }
  });
});

/**
 * The demo pack's figures scaled by `k` (adversarial review r1, REPRO 3): with eight data
 * columns and figures in the billions the label column was left too little room, "Operating
 * expenses" wrapped, and page 6 spilled onto a thirteenth sheet, because the fit model charged
 * every table a 40% label column. `loss` doubles operating expenses; `negative` makes revenue
 * a net debit (the Brightsphere shape). Shapes and scales from that review.
 */
function scaled(k: number, negative: boolean, loss: boolean): BoardPackInput {
  const c = demoSet.current;
  const m = (v: number) => Math.round(v * k);
  const s = negative ? -1 : 1;
  const opexK = loss ? 2 : 1;
  const current = { ...c, revenue: m(c.revenue) * s, costOfSales: m(c.costOfSales), operatingExpenses: m(c.operatingExpenses) * opexK,
    otherIncome: m(c.otherIncome ?? 0), otherExpenses: m(c.otherExpenses ?? 0) };
  const op = current.revenue - current.costOfSales + current.otherIncome - current.operatingExpenses;
  const b = demoSet.budget!.bands;
  const bands = { ...b, 'is.revenue': m(b['is.revenue']!) * s, 'is.costOfSales': m(b['is.costOfSales']!),
    'is.otherIncome': m(b['is.otherIncome']!), 'is.operatingExpenses': m(b['is.operatingExpenses']!) * opexK, 'is.otherExpenses': m(b['is.otherExpenses']!) };
  bands['is.grossProfit'] = bands['is.revenue'] - bands['is.costOfSales'];
  bands['is.operating'] = bands['is.grossProfit'] + bands['is.otherIncome'] - bands['is.operatingExpenses'];
  bands['is.netProfit'] = bands['is.operating'] - bands['is.otherExpenses'];
  const pr = demoSet.prior!;
  const prior = { ...pr, revenue: m(pr.revenue) * s, costOfSales: m(pr.costOfSales), operatingExpenses: m(pr.operatingExpenses),
    operatingProfit: m(pr.operatingProfit ?? 0), netProfit: m(pr.netProfit), otherIncome: m(pr.otherIncome ?? 0), otherExpenses: m(pr.otherExpenses ?? 0) };
  return { ...demoInput, set: { ...demoSet, current: { ...current, operatingProfit: op, netProfit: op - current.otherExpenses }, prior, budget: { ...demoSet.budget!, bands } } };
}

const page6Notes = (document: ReturnType<typeof buildBoardPackPages>): string[] =>
  document.pages.find((p) => p.navLabel === 'Income statement')!.footnotes.map((f) => f.text);

describe('page 6 says so when it leaves the budget columns out', () => {
  it.each([
    ['no bridge rung fits with them', 3000, true],
  ] as const)('prints the dropped-columns footnote when %s', (_name, k, negative) => {
    expect(page6Notes(buildBoardPackPages(scaled(k, negative, false)))).toContain(DROPPED_NOTE);
  });

  it.each([[3000]])('prints the footnote in the PDF text layer at k=%i, page 6 inside its edge, and the pack passes the gate', async (k) => {
    const document = buildBoardPackPages(scaled(k, true, false));
    expect(() => assertPackIntegrity(document)).not.toThrow();
    const out = await printBoardPack(document, browser);
    // Page 3 already overflows at this figure (it did before the footnote); page 6 must not.
    expect(out.overflow.filter((o) => o.id === 'pack-page-6')).toEqual([]);
    expect(out.sheets).toBe(document.pages.length);
    expect(flat(incomeSheet(out))).toContain(DROPPED_NOTE);
  }, 180_000);

  it('does not print it when the columns fit', async () => {
    expect(page6Notes(doc)).not.toContain(DROPPED_NOTE);
    expect(flat(incomeSheet())).not.toContain('left out of this page');
  });
});

describe('page 6 with a budget at the figures that spilled it', () => {
  it('keeps the budget columns and their basis footnote at k=1220: the derived caption goes first, not the footnote', async () => {
    const document = buildBoardPackPages(scaled(1220, true, false));
    const page = document.pages.find((p) => p.navLabel === 'Income statement')!;
    const income = page.blocks
      .flatMap((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue') ? [b.table] : []))[0]!;
    expect(income.columns).toEqual(expect.arrayContaining(['budget', 'variance']));
    expect(page.footnotes.some((f) => f.text.startsWith('The budget column'))).toBe(true);
    expect(page.footnotes.some((f) => f.text === DROPPED_NOTE)).toBe(false);
    expect(page.blocks.some((b) => b.kind === 'narrative')).toBe(false);
    const out = await printBoardPack(document, browser);
    expect(out.overflow.filter((o) => o.id === 'pack-page-6')).toEqual([]);
    expect(out.sheets).toBe(document.pages.length);
    const sheet = out.sheetText.find((t) => /Gross profit/.test(t) && /Net profit/.test(t));
    expect(flat(sheet ?? '')).toMatch(/budget/i);
  }, 180_000);

  it('drops the budget columns when fitting them would remove their basis footnote', () => {
    const document = buildBoardPackPages(scaled(3000, true, false));
    const page = document.pages.find((p) => p.navLabel === 'Income statement')!;
    const income = page.blocks
      .flatMap((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue') ? [b.table] : []))[0]!;
    expect(income.columns).not.toContain('budget');
    expect(income.columns).not.toContain('variance');
    expect(income.columnNotes?.some((note) => note.column === 'budget')).toBe(false);
    expect(page.footnotes.some((footnote) => footnote.text.startsWith('The budget column'))).toBe(false);
  });

  it.each([
    ['a loss at about R12.6bn of revenue', 3000, false, true],
    ['a net-debit revenue of about R840m', 200, true, false],
  ] as const)('%s prints on as many sheets as it has pages, with nothing past the edge', async (_name, k, negative, loss) => {
    const document = buildBoardPackPages(scaled(k, negative, loss));
    const out = await printBoardPack(document, browser);
    expect(out.overflow).toEqual([]);
    expect(out.sheets).toBe(document.pages.length);
  }, 180_000);

  it('a net-debit revenue of about R12.6bn, which no bridge rung can fit with the columns, prints without them rather than refusing the pack', async () => {
    const document = buildBoardPackPages(scaled(3000, true, false));
    expect(() => assertPackIntegrity(document)).not.toThrow();
    const income = document.pages.flatMap((p) => p.blocks)
      .flatMap((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue') ? [b.table] : []))[0]!;
    expect(income.columns).not.toContain('budget');
    expect(income.columns).not.toContain('variance');
    expect(document.pages.flatMap((p) => p.footnotes ?? []).some((f) => f.text.startsWith('The budget column'))).toBe(false);
    const out = await printBoardPack(document, browser);
    expect(out.sheets).toBe(document.pages.length);
  }, 180_000);
});
