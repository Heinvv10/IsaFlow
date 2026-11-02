/**
 * Budgets P3 PR-E, printed: page 6 of a pack whose company has a budget carries Budget and
 * Variance, eight data columns where it had six. Proven on paper, not on the model: the real
 * print stylesheet, Chromium's PDF and its text layer (`printBoardPack`). Nothing may run past
 * the paper's right edge, the two headings must be on the income statement's sheet, and every
 * budget figure must print whole (a cell too narrow for it wraps the figure across two lines).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { formatStatementFigure, MONEY_SCALES } from '@/lib/format/money';
import { demoInput, demoSet } from '../services/packs/fixtures/boardPackInputs';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/packBoardPackInput';
import { printBoardPack, type PrintedPack } from './renderPackPdf';

let browser: Browser;
let printed: PrintedPack;
const doc = buildBoardPackPages(demoInput);

beforeAll(async () => {
  browser = await chromium.launch();
  printed = await printBoardPack(doc, browser);
}, 180_000);
afterAll(async () => { await browser?.close(); });

/** The sheet the income statement printed on: the one carrying its rows. */
const incomeSheet = (): string => {
  const sheet = printed.sheetText.find((t) => /Gross profit/.test(t) && /Operating expenses/.test(t) && /Net profit/.test(t));
  if (!sheet) throw new Error('no printed sheet carries the income statement');
  return sheet.replace(/ /g, ' ');
};

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

describe('page 6 with a budget at the figures that spilled it', () => {
  it.each([
    ['a loss at about R12.6bn of revenue', 3000, false, true],
    ['a net-debit revenue of about R840m', 200, true, false],
  ] as const)('%s prints on as many sheets as it has pages, with nothing past the edge', async (_name, k, negative, loss) => {
    const document = buildBoardPackPages(scaled(k, negative, loss));
    const out = await printBoardPack(document, browser);
    expect(out.overflow).toEqual([]);
    expect(out.sheets).toBe(document.pages.length);
  }, 180_000);
});
