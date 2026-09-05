/**
 * SharedPackView — what a person with no session sees.
 *
 * Rendered with renderToStaticMarkup (node environment, no DOM), same pattern
 * as StatementGrid.test.ts. Two things this suite exists to hold: the pack's
 * figures must actually appear (a shared document that silently renders empty
 * is worse than an error page), and the markup must contain NOTHING that leads
 * back into the application — no nav, no anchors, no draft commentary.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharedPackView } from '@/components/accounting/share/SharedPackView';
import type { SharedPack } from '@/modules/accounting/services/share/sharedPackService';

const pack: SharedPack = {
  companyName: 'Brightsphere (Pty) Ltd',
  period: { from: '2026-03-01', to: '2026-08-31' },
  commentary: [
    { sectionRef: 'income_statement', rowRef: 'netProfit', text: 'Margin recovered after the March price review.' },
    { sectionRef: 'balance_sheet', rowRef: 'cash', text: 'Cash includes the call account.' },
  ],
  unclassifiedAccounts: null,
  pack: {
    type: 'management',
    companyName: 'Brightsphere (Pty) Ltd',
    period: '2026-03-01 to 2026-08-31',
    generatedAt: '2026-09-06T00:00:00.000Z',
    sections: [
      {
        type: 'income_statement',
        title: 'Income Statement',
        data: {
          revenue: 5_000_000, costOfSales: 3_000_000, grossProfit: 2_000_000,
          otherIncome: 100_000, operatingExpenses: 1_200_000, operatingProfit: 900_000,
          otherExpenses: 50_000, netProfit: 850_000, grossMargin: 40, netMargin: 17,
        },
      },
      {
        type: 'balance_sheet',
        title: 'Balance Sheet',
        data: {
          totalAssets: 4_000_000, totalLiabilities: 1_500_000, totalEquity: 2_500_000,
          currentAssets: 2_200_000, cash: 750_000, accountsReceivable: 900_000, accountsPayable: 400_000,
        },
      },
      {
        type: 'cash_flow',
        title: 'Cash Flow',
        data: { operatingCashFlow: 640_000, investingCashFlow: -120_000, note: 'not a number' },
      },
      {
        type: 'ratios',
        title: 'Financial Ratios',
        data: { currentRatio: -0.58, debtToEquity: 2.4 },
      },
      { type: 'kpis', title: 'KPI Scorecard', data: { scorecard: [{ name: 'Gross margin', value: 40 }] } },
      { type: 'waterfall', title: 'Profit Waterfall', data: { steps: [{ label: 'Revenue', value: 1 }] } },
      { type: 'trends', title: 'Trend Analysis', data: { series: [1, 2, 3] } },
      { type: 'commentary', title: 'Commentary', data: { summary: 'Generated summary nobody approved.' } },
    ],
  },
} as SharedPack;

const html = renderToStaticMarkup(React.createElement(SharedPackView, { data: pack }));

describe('SharedPackView', () => {
  it('names the company and the period it covers', () => {
    expect(html).toContain('Brightsphere (Pty) Ltd');
    expect(html).toContain('2026-03-01');
    expect(html).toContain('2026-08-31');
    expect(html).toContain('Management pack');
  });

  it('renders every section the pack carries, keyed by its type', () => {
    for (const t of ['income_statement', 'balance_sheet', 'cash_flow', 'ratios', 'kpis', 'waterfall', 'trends', 'commentary']) {
      expect(html).toContain(`data-section="${t}"`);
    }
    expect(html).toContain('Income Statement');
    expect(html).toContain('Balance Sheet');
    expect(html).toContain('Cash Flow');
  });

  it('renders the P&L bands and both margins from the pack', () => {
    // en-ZA grouping with a space; formatMoney with cents.
    expect(html).toMatch(/5\s000\s000\.00/);
    expect(html).toContain('Net Profit / (Loss)');
    expect(html).toContain('Gross margin 40.0%');
    expect(html).toContain('Net margin 17.0%');
  });

  it('renders the balance sheet with its detail lines', () => {
    expect(html).toContain('Total Assets');
    expect(html).toContain('Total Liabilities and Equity');
    expect(html).toContain('Accounts Receivable');
  });

  it('renders approved commentary under its own section only', () => {
    expect(html).toContain('Margin recovered after the March price review.');
    expect(html).toContain('Cash includes the call account.');
    const isIndex = html.indexOf('data-section="income_statement"');
    const bsIndex = html.indexOf('data-section="balance_sheet"');
    const marginNote = html.indexOf('Margin recovered');
    expect(marginNote).toBeGreaterThan(isIndex);
    expect(marginNote).toBeLessThan(bsIndex);
  });

  it('renders a generic section as numeric key/value pairs, skipping non-numbers', () => {
    expect(html).toContain('Operating Cash Flow');
    expect(html).toContain('Investing Cash Flow');
    expect(html).toContain('640 000');
    expect(html).not.toContain('not a number');
  });

  it('prints ratios to two decimals, never through the money formatter', () => {
    // formatMoney rounds to whole units: -0.58 came out as "(1)", a wrong
    // figure on a document a company hands to its bank.
    expect(html).toContain('-0.58');
    expect(html).toContain('2.40');
    expect(html).not.toContain('(1)');
  });

  it('contains no link back into the application and no nav', () => {
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('<button');
  });

  it('says plainly that the array-shaped sections are not on a shared link', () => {
    // An empty heading on a document sent to a client reads as a rendering
    // failure. Three headings did exactly that before this.
    const notes = html.match(/Not included on shared links\./g) ?? [];
    expect(notes).toHaveLength(3);
    for (const t of ['kpis', 'waterfall', 'trends']) {
      const at = html.indexOf(`data-section="${t}"`);
      const nextSection = html.indexOf('data-section="', at + 1);
      const body = nextSection === -1 ? html.slice(at) : html.slice(at, nextSection);
      expect(body).toContain('Not included on shared links.');
    }
  });

  it('never renders the pack\'s own generated commentary summary', () => {
    // The commentary section shows APPROVED text only. The pack's generated
    // summary has been through no approval and must not reach a third party.
    expect(html).not.toContain('Generated summary nobody approved.');
    expect(html).toContain('No approved commentary for this period.');
  });

  it('renders approved commentary in the commentary section instead of the empty state', () => {
    const withNote = renderToStaticMarkup(React.createElement(SharedPackView, {
      data: {
        ...pack,
        commentary: [...pack.commentary, { sectionRef: 'commentary', rowRef: 'summary', text: 'Approved closing note.' }],
      },
    }));
    expect(withNote).toContain('Approved closing note.');
    expect(withNote).not.toContain('No approved commentary for this period.');
  });
});