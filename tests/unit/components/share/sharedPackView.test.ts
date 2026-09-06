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
import { SharedPackView, type SharedPackProps } from '@/components/accounting/share/SharedPackView';

const pack: SharedPackProps = {
  companyName: 'Brightsphere (Pty) Ltd',
  period: { from: '2026-03-01', to: '2026-08-31' },
  commentary: [
    { sectionRef: 'income_statement', rowRef: 'netProfit', text: 'Margin recovered after the March price review.' },
    { sectionRef: 'balance_sheet', rowRef: 'cash', text: 'Cash includes the call account.' },
  ],
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
      // As the page builds them: named, with no data at all. `cash_flow` is
      // among them because `buildSectionData` synthesizes that section from the
      // income statement rather than the ledger.
      { type: 'cash_flow', title: 'Cash Flow' },
      { type: 'ratios', title: 'Financial Ratios' },
      { type: 'kpis', title: 'KPI Scorecard' },
      { type: 'waterfall', title: 'Profit Waterfall' },
      { type: 'trends', title: 'Trend Analysis' },
      { type: 'commentary', title: 'Commentary' },
    ],
  },
};

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

  it('renders a section it has no bespoke shape for as numeric key/value pairs', () => {
    // The fallback branch, exercised on a section type this view does not know:
    // every section a real pack carries today is either drawn by name or
    // omitted, and this keeps the fallback honest for the next one added.
    const future = renderToStaticMarkup(React.createElement(SharedPackView, {
      data: {
        ...pack,
        pack: {
          ...pack.pack,
          sections: [{ type: 'segments', title: 'Segments', data: { northRegion: 640_000, note: 'not a number' } }],
        },
      },
    }));
    expect(future).toContain('North Region');
    expect(future).toContain('640 000');
    expect(future).not.toContain('not a number');
  });

  it('never draws a rand figure under the synthesized cash flow heading', () => {
    // `buildSectionData` sets operating cash flow to net profit and investing
    // and financing to zero, because no caller supplies the three optional
    // inputs. That is a placeholder on the owner's own screen and a false
    // statement of cash movement on a document sent to a bank.
    const smuggled = renderToStaticMarkup(React.createElement(SharedPackView, {
      data: {
        ...pack,
        pack: {
          ...pack.pack,
          sections: pack.pack.sections.map(sec => sec.type === 'cash_flow'
            ? { ...sec, data: { operatingCashFlow: 333_111, investingCashFlow: 0, closingCash: 222_444 } }
            : sec),
        },
      },
    }));
    expect(smuggled).not.toContain('Operating Cash Flow');
    expect(smuggled).not.toContain('333 111');
    expect(smuggled).not.toContain('222 444');
    const at = smuggled.indexOf('data-section="cash_flow"');
    const next = smuggled.indexOf('data-section="', at + 1);
    expect(smuggled.slice(at, next)).toContain('Not included on shared links.');
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
    expect(notes).toHaveLength(5);
    for (const t of ['kpis', 'waterfall', 'trends', 'ratios', 'cash_flow']) {
      const at = html.indexOf(`data-section="${t}"`);
      const nextSection = html.indexOf('data-section="', at + 1);
      const body = nextSection === -1 ? html.slice(at) : html.slice(at, nextSection);
      expect(body).toContain('Not included on shared links.');
    }
  });

  it('renders its commentary through the shared CommentaryBlock, not a local copy', () => {
    // The share page had a second published renderer of its own. One renderer
    // for the output that leaves the building: the marker below is
    // CommentaryBlock's, and its absence means a local copy came back.
    expect(html).toContain('data-commentary="published"');
    expect(html).not.toContain('data-commentary="internal"');
  });

  it('shows the commentary empty state when no approved note exists', () => {
    expect(html).toContain('No approved commentary for this period.');
  });

  it('draws nothing from a section the page stripped, even if data reappears', () => {
    // Defence in depth against the strip being lost: the view must not draw a
    // figure for an omitted section just because one arrived in the props.
    const smuggled = renderToStaticMarkup(React.createElement(SharedPackView, {
      data: {
        ...pack,
        pack: {
          ...pack.pack,
          sections: pack.pack.sections.map(sec =>
            sec.type === 'ratios' ? { ...sec, data: { currentRatio: -0.58, ebitda: 1_819_000 } } : sec),
        },
      },
    }));
    expect(smuggled).not.toContain('-0.58');
    expect(smuggled).not.toContain('1 819 000');
    expect(smuggled).toContain('Not included on shared links.');
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
  /**
   * WS2 made `packToMargins` nullable — a margin on non-positive turnover is
   * no margin, not a margin of zero — while this view still called
   * `.toFixed(1)` on the result. A link shared on a loss-making period would
   * have thrown for its recipient, who has no session and no way back.
   */
  it('prints the reason, not a crash, when turnover leaves no margin', () => {
    const lossMaking = () => renderToStaticMarkup(React.createElement(SharedPackView, {
      data: {
        ...pack,
        pack: {
          ...pack.pack,
          sections: pack.pack.sections.map(sec =>
            sec.type === 'income_statement'
              ? { ...sec, data: { ...sec.data, revenue: -100, grossMargin: null, netMargin: null } }
              : sec),
        },
      },
    }));

    expect(lossMaking).not.toThrow();
    const html = lossMaking();
    expect(html).toContain('No margin on non-positive turnover');
    expect(html).not.toContain('0.0%');
  });
});
