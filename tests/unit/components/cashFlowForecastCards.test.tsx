// Cash flow forecast: the monthly breakdown becomes labelled cards below lg; the period select and Refresh are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: {
      currentBalance: 1000,
      generatedAt: '2026-11-22T10:00:00Z',
      alerts: [],
      assumptions: ['Based on 12 months of history'],
      historical: [],
      forecastPoints: [{ date: '2026-12-01', label: 'Dec 2026', projectedInflow: 500, projectedOutflow: 300, projectedNet: 200, projectedBalance: 1200, confidence: 80 }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/cash-flow-forecast';

afterEach(cleanup);

describe('Cash flow forecast on touch', () => {
  it('turns the monthly breakdown into labelled cards; the month cell has no label so it heads the card', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Dec 2026');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['Month', 'Inflow', 'Outflow', 'Net', 'Balance', 'Confidence']);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual([null, 'Inflow', 'Outflow', 'Net', 'Balance', 'Confidence']);
  });

  it('makes the period select and Refresh 44px, and the header wraps', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Dec 2026');
    expect(container.querySelector('select')!.className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /Refresh/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap');
  });
});
