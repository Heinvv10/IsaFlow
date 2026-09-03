/**
 * Guards against the "written but never read" defect.
 *
 * The resolver reports what it had to assume — accounts defaulted to current,
 * and whether inventory could be identified at all. Emitting those on the API
 * and never rendering them would move the audit's core defect (a figure that
 * looks authoritative while resting on a guess) one layer outwards. This suite
 * checks both halves: the wording is built correctly, AND every page consuming
 * a warning-emitting endpoint actually renders it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDataQualityNotices } from '@/modules/accounting/services/reports/dataQualityNotices';

const ROOT = join(__dirname, '../../..');

describe('buildDataQualityNotices', () => {
  it('says nothing when there is nothing to disclose', () => {
    expect(buildDataQualityNotices({})).toEqual([]);
    expect(buildDataQualityNotices({ unclassifiedAccounts: null, inventory: null })).toEqual([]);
    // A zero-count warning is not a warning.
    expect(
      buildDataQualityNotices({
        unclassifiedAccounts: { accounts: 0, amount: 0, message: 'x' },
      }),
    ).toEqual([]);
  });

  it('states the account count and the amount that was defaulted', () => {
    // Velocity Fibre's real figures.
    const [notice] = buildDataQualityNotices({
      unclassifiedAccounts: { accounts: 13, amount: 117_139_882.5, message: 'ignored' },
    });
    expect(notice).toContain('13 accounts');
    // en-ZA: NON-BREAKING space (U+00A0) thousands separator, comma decimal.
    // \s matches U+00A0, so this asserts the grouping without hard-coding it.
    expect(notice).toMatch(/117\s139\s882,50/);
    expect(notice).toMatch(/default was applied/i);
  });

  it('uses the singular for exactly one account', () => {
    const [notice] = buildDataQualityNotices({
      unclassifiedAccounts: { accounts: 1, amount: 100, message: 'ignored' },
    });
    expect(notice).toContain('1 account ');
    expect(notice).not.toContain('1 accounts');
  });

  it('formats a negative defaulted balance rather than hiding it', () => {
    // ISAFlow Demo's real figure is negative.
    const [notice] = buildDataQualityNotices({
      unclassifiedAccounts: { accounts: 4, amount: -119_735.72, message: 'ignored' },
    });
    expect(notice).toMatch(/-119\s735,72/);
  });

  it('passes the inventory message through verbatim', () => {
    const message = 'No GL account is classified as inventory, so the quick ratio does not exclude it.';
    expect(buildDataQualityNotices({ inventory: { resolved: false, message } })).toEqual([message]);
  });

  it('returns both notices together', () => {
    const notices = buildDataQualityNotices({
      unclassifiedAccounts: { accounts: 4, amount: -119_735.72, message: 'ignored' },
      inventory: { resolved: false, message: 'INVENTORY_MESSAGE' },
    });
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe('INVENTORY_MESSAGE');
  });
});

describe('warning wiring — emitted must mean rendered', () => {
  /**
   * ALL TEN endpoints that route through the classification resolver. The
   * guard originally listed only the five that already emitted, so it passed
   * while ai-commentary, reports-html, reports-ratio-trends,
   * reports-three-way-forecast and reports-waterfall surfaced nothing — the
   * guard matched the wiring instead of the claim.
   */
  const EMITTERS = [
    'pages/api/accounting/reports-ratios.ts',
    'pages/api/accounting/reports-pack.ts',
    'pages/api/accounting/reports-executive-summary.ts',
    'pages/api/accounting/reports-extended-ratios.ts',
    'pages/api/accounting/reports-kpi-scorecard.ts',
    'pages/api/accounting/ai-commentary.ts',
    'pages/api/accounting/reports-html.ts',
    'pages/api/accounting/reports-ratio-trends.ts',
    'pages/api/accounting/reports-three-way-forecast.ts',
    'pages/api/accounting/reports-waterfall.ts',
  ];
  /** Every page that displays figures from one of those endpoints. */
  const CONSUMERS = [
    'pages/accounting/reports/financial-analysis.tsx',
    'pages/accounting/reports/executive-dashboard.tsx',
    'pages/accounting/reports/report-packs.tsx',
    'pages/accounting/reports/waterfall.tsx',
    'pages/accounting/reports/three-way-forecast.tsx',
  ];

  it.each(EMITTERS)('%s emits at least one data-quality warning', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toMatch(/unclassifiedWarning\(|inventoryWarning\(/);
  });

  it.each(CONSUMERS)('%s renders DataQualityNotice', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toContain("from '@/components/accounting/DataQualityNotice'");
    expect(src).toMatch(/<DataQualityNotice/);
  });

  it.each(CONSUMERS)('%s reads a warning field off the API response', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toMatch(/\.unclassifiedAccounts|\.inventory\b/);
  });

  it('renders the notice component through the shared builder', () => {
    const src = readFileSync(
      join(ROOT, 'src/components/accounting/DataQualityNotice.tsx'),
      'utf8',
    );
    expect(src).toMatch(/buildDataQualityNotices\(/);
    expect(src).toMatch(/notices\.length === 0.*return null/s);
  });
});

describe('per-type unclassified wording', () => {
  it('names the type and what it was defaulted to', () => {
    // Production's real expense cohort.
    const notices = buildDataQualityNotices({
      unclassifiedAccounts: {
        accounts: 43,
        amount: 158_812_322.71,
        message: 'ignored',
        byType: [
          { type: 'expense', accounts: 39, amount: 114_177_043.06,
            defaultedTo: 'operating expenses rather than cost of sales' },
          { type: 'revenue', accounts: 4, amount: 44_635_279.65,
            defaultedTo: 'revenue rather than other income' },
        ],
      },
    });
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('39 expense accounts');
    expect(notices[0]).toMatch(/114\s177\s043,06/);
    expect(notices[0]).toContain('operating expenses rather than cost of sales');
    expect(notices[1]).toContain('4 revenue accounts');
    expect(notices[1]).toContain('revenue rather than other income');
  });

  it('uses the singular for one account of a type', () => {
    const [n] = buildDataQualityNotices({
      unclassifiedAccounts: {
        accounts: 1, amount: 500, message: 'ignored',
        byType: [{ type: 'liability', accounts: 1, amount: 500, defaultedTo: 'current liabilities' }],
      },
    });
    expect(n).toContain('1 liability account ');
    expect(n).toContain('was treated as');
    expect(n).not.toContain('accounts');
  });

  it('drops types with nothing to report', () => {
    const notices = buildDataQualityNotices({
      unclassifiedAccounts: {
        accounts: 7, amount: 100, message: 'ignored',
        byType: [
          { type: 'asset', accounts: 7, amount: 100, defaultedTo: 'current assets' },
          { type: 'equity', accounts: 0, amount: 0, defaultedTo: '' },
        ],
      },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('asset');
    expect(notices[0]).not.toContain('equity');
  });
});

describe('endpoints without a UI carry the caveat in what they DO return', () => {
  it('ai-commentary carries the caveat inside its narrative, not a sibling field', () => {
    // This endpoint has no UI — it is consumed as prose. A field nobody renders
    // is the same defect this suite exists to prevent.
    const src = readFileSync(join(ROOT, 'pages/api/accounting/ai-commentary.ts'), 'utf8');
    expect(src).toMatch(/riskAreas\.unshift\(/);
    expect(src).toMatch(/Unclassified Accounts/);
  });

  it('reports-html puts the caveat in the document it returns', () => {
    // Also has no UI: it returns an HTML file, so the caveat has to be in it.
    const src = readFileSync(join(ROOT, 'pages/api/accounting/reports-html.ts'), 'utf8');
    expect(src).toMatch(/buildDataQualityNotices\(/);
    expect(src).toMatch(/noticesHtml/);
  });
});
