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
    expect(notice).toContain('treated as current');
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
  const EMITTERS = [
    'pages/api/accounting/reports-ratios.ts',
    'pages/api/accounting/reports-pack.ts',
    'pages/api/accounting/reports-executive-summary.ts',
    'pages/api/accounting/reports-extended-ratios.ts',
    'pages/api/accounting/reports-kpi-scorecard.ts',
  ];
  const CONSUMERS = [
    'pages/accounting/reports/financial-analysis.tsx',
    'pages/accounting/reports/executive-dashboard.tsx',
    'pages/accounting/reports/report-packs.tsx',
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
