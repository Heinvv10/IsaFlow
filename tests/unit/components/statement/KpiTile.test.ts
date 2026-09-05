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
    expect(render({ label: 'Revenue', value: 4812345, kind: 'money' })).toContain('R 4 812 345');
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
    expect(html).toContain('R 4 500 000');
    expect(html).toMatch(/data-fav="true"[^>]*>\+6\.9%/);
  });

  it('renders without comparator, delta or trend', () => {
    const html = render({ label: 'Cash', value: 0, kind: 'money' });
    expect(html).not.toContain('<svg');
    // formatMoney(0, { symbol: true }) returns '–' — the zero dash wins over the symbol.
    expect(html).toContain('–');
  });
});
