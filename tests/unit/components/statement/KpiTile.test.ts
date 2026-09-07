/**
 * KpiTile — rendered with renderToStaticMarkup, same pattern as
 * StatementGrid.test.ts, per controller ruling (no @testing-library/react,
 * no happy-dom).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KpiTile } from '@/components/accounting/kpi/KpiTile';

const render = (props: Parameters<typeof KpiTile>[0]) =>
  renderToStaticMarkup(React.createElement(KpiTile, props));

describe('KpiTile', () => {
  it('formats money, pct and ratio by kind', () => {
    expect(render({ label: 'Revenue', value: 4812345, kind: 'money' })).toContain('R 4\u00a0812\u00a0345');
    expect(render({ label: 'GP%', value: 54.49, kind: 'pct' })).toContain('54.5%');
    expect(render({ label: 'Current ratio', value: 1.847, kind: 'ratio' })).toContain('1.85');
  });

  it('shows the comparator and a signed delta coloured by favourability', () => {
    const html = render({
      label: 'Revenue', value: 4812345, kind: 'money',
      comparator: { label: 'vs budget', value: 4500000 },
      deltaPct: 6.94, favourable: true,
    });
    expect(html).toContain('vs budget');
    expect(html).toContain('R 4\u00a0500\u00a0000');
    expect(html).toMatch(/data-fav="true"[^>]*>\+6\.9%/);
  });

  it('renders without comparator, delta or trend', () => {
    const html = render({ label: 'Cash', value: 0, kind: 'money' });
    expect(html).not.toContain('<svg');
    // formatMoney(0, { symbol: true }) returns '–' — the zero dash wins over the symbol.
    expect(html).toContain('–');
  });

  // Added for the executive-dashboard fix: the Debt/Equity KPI tile showed a
  // numeric ratio while the KPI Scorecard, for the same period, marked the
  // same ratio "Not meaningful" (negative equity inverts it) — same page,
  // contradictory verdicts. `unavailable` lets the tile defer to the
  // scorecard's own predicate instead of always showing a number.
  it('renders the unavailable text instead of the figure when set', () => {
    const html = render({ label: 'Debt/equity', value: -2.47, kind: 'ratio', unavailable: 'Not meaningful' });
    expect(html).toContain('Not meaningful');
    expect(html).not.toContain('-2.47');
  });

  it('suppresses the delta badge when unavailable is set', () => {
    const html = render({
      label: 'Debt/equity', value: -2.47, kind: 'ratio',
      unavailable: 'Not meaningful', deltaPct: 5, favourable: true,
    });
    expect(html).not.toContain('+5.0%');
  });
});
