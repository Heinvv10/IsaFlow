/**
 * Golden path (p): type scale and money/date display (master plan 3b).
 *
 * Reads the rendered dashboard, invoice list and P&L and checks what a person sees:
 *   - every amount ("R 25 000.00") is set with tabular-nums in a proportional face, never a monospace one;
 *   - no date is shown as 2026/10/21 or 2026-10-21; the invoice list shows them as "21 Oct 2026";
 *   - no text is smaller than 12 px.
 * Display only: it reads computed styles and text, never an API body.
 */
import { test, expect, type Page } from '@playwright/test';

// \xa0 is the non-breaking space the formatters group thousands with.
const MONEY = /^-?R\s[\d\xa0]+\.\d{2}$/;
// The statements print figures in the statement convention: no R, brackets for negatives, spaced thousands.
const STATEMENT_FIGURE = /^\(?-?\d{1,3}(?:(?:[\xa0 ]\d{3})+(?:\.\d{2})?|\.\d{2})\)?$/;
const DISPLAY_DATE = /^\d{2} [A-Z][a-z]{2} \d{4}$/;
const NUMERIC_DATE = /\b\d{4}[/-]\d{2}[/-]\d{2}\b/;

const SCREENS = [
  { name: 'dashboard', path: '/accounting', amount: MONEY },
  { name: 'invoice list', path: '/accounting/customer-invoices', amount: MONEY },
  {
    name: 'income statement',
    path: '/accounting/reports/income-statement?period_start=2025-03-01&period_end=2026-10-24',
    amount: STATEMENT_FIGURE,
  },
];

interface Probe {
  amounts: number;
  notTabular: string[];
  mono: string[];
  numericDates: string[];
  displayDates: number;
  small: string[];
}

async function probe(page: Page, amount: RegExp): Promise<Probe> {
  return page.evaluate(
    ({ amountSource, displaySource, numericSource }) => {
      const amountRe = new RegExp(amountSource);
      const displayRe = new RegExp(displaySource);
      const numericRe = new RegExp(numericSource);
      const out: Probe = { amounts: 0, notTabular: [], mono: [], numericDates: [], displayDates: 0, small: [] };
      document.querySelectorAll('body *').forEach((el) => {
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? '')
          .join(' ')
          .trim();
        if (!own) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('script,style,noscript')) return;
        if (parseFloat(cs.fontSize) < 12) out.small.push(`${cs.fontSize} "${own.slice(0, 24)}"`);
        if (amountRe.test(own)) {
          out.amounts += 1;
          if (!/tabular-nums/.test(cs.fontVariantNumeric)) out.notTabular.push(own);
          if (/mono|monaco|consolas|courier/i.test(cs.fontFamily)) out.mono.push(`${own} (${cs.fontFamily.slice(0, 30)})`);
        }
        if (numericRe.test(own)) out.numericDates.push(own.slice(0, 40));
        if (displayRe.test(own)) out.displayDates += 1;
      });
      return out;
    },
    { amountSource: amount.source, displaySource: DISPLAY_DATE.source, numericSource: NUMERIC_DATE.source },
  );
}

for (const screen of SCREENS) {
  test(`${screen.name}: tabular amounts, dd MMM yyyy dates, nothing under 12 px`, async ({ page }) => {
    await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (source) => {
        const re = new RegExp(source);
        return [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && re.test(el.textContent?.trim() ?? ''));
      },
      screen.amount.source,
      { timeout: 90_000 },
    );
    await page.waitForTimeout(1500); // late rows: widgets and tables fill in after the first amount
    const seen = await probe(page, screen.amount);

    expect(seen.amounts, 'the screen shows at least one amount').toBeGreaterThan(0);
    expect(seen.notTabular, 'amounts without tabular-nums').toEqual([]);
    expect(seen.mono, 'amounts set in a monospace face').toEqual([]);
    expect(seen.numericDates, 'dates shown as yyyy/mm/dd or yyyy-mm-dd').toEqual([]);
    expect(seen.small, 'text under 12 px').toEqual([]);
    if (screen.name === 'invoice list') {
      expect(seen.displayDates, 'the invoice list shows its dates as "21 Oct 2026"').toBeGreaterThan(0);
    }
  });
}
