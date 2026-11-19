/**
 * The grid's group total rows keep acronyms in capitals ("Total SARS", not "Total sars") and lower-case the rest
 * ("Total payroll"); the warnings panel shows the SARS assumed-paid warning as one readable line with the
 * itemised returns collapsed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ForecastGrid } from '@/components/accounting/cashForecast13/ForecastGrid';
import { WarningsList } from '@/components/accounting/cashForecast13/Cash13Summary';
import { totalRowLabel } from '@/components/accounting/cashForecast13/forecastRows';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';
import { forecastFixture } from './fixture';

afterEach(() => { cleanup(); });
const nb = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');

describe('group total row labels', () => {
  it('keeps acronyms in capitals and lower-cases the other words', () => {
    expect(totalRowLabel('SARS')).toBe('Total SARS');
    expect(totalRowLabel('Payroll')).toBe('Total payroll');
    expect(totalRowLabel('Receipts from customers')).toBe('Total receipts from customers');
    expect(totalRowLabel('Expected items you added')).toBe('Total expected items you added');
  });

  it('the rendered grid reads "Total SARS", "Total payroll" and "Total receipts from customers"', () => {
    render(<ForecastGrid forecast={forecastFixture({ overrides: [] })} overrides={new Map()} />);
    const rows = screen.getAllByRole('rowheader').map((r) => r.textContent);
    expect(rows).toContain('Total SARS');
    expect(rows).toContain('Total payroll');
    expect(rows).toContain('Total receipts from customers');
    expect(rows).not.toContain('Total sars');
  });
});

describe('the SARS assumed-paid warning in the panel', () => {
  const many = (n: number): ForecastWarning => ({
    code: 'sars_past_due_assumed_paid', source: 'sars', message: `${n} SARS item(s) due before today and not marked filed are assumed paid (in opening cash): lots of text`,
    assumedPaid: Array.from({ length: n }, (_, i) => ({
      kind: 'EMP201', periodStart: `2025-${String(i + 1).padStart(2, '0')}-01`, periodEnd: `2025-${String(i + 1).padStart(2, '0')}-28`,
      dueDate: `2025-${String(i + 2).padStart(2, '0')}-07`, cents: -100_000,
    })),
  });

  it('many returns: one summary line, the list collapsed behind "Show the 11 returns"', () => {
    const { container } = render(<WarningsList warnings={[many(11)]} />);
    const li = screen.getByTestId('cash13-warnings').querySelector('li') as HTMLElement;
    expect(nb(li.textContent)).toContain('11 returns due 7 Feb 2025 to 7 Dec 2025, R 11 000.00 in total, are not marked filed.');
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Show the 11 returns')).toBeTruthy();
    expect(details.querySelectorAll('li').length).toBe(11);
  });

  it('a single return has no list to expand', () => {
    const { container } = render(<WarningsList warnings={[many(1)]} />);
    expect(container.querySelector('details')).toBeNull();
    expect(nb(screen.getByTestId('cash13-warnings').textContent)).toContain('1 return due 7 Feb 2025, R 1 000.00, is not marked filed.');
  });

  it('the list rows have stable keys: reordering the returns moves the rows, it does not rewrite them', () => {
    const w = many(3);
    const { container, rerender } = render(<WarningsList warnings={[w]} />);
    const rowFor = (text: string) => [...container.querySelectorAll('details li')].find((li) => li.textContent?.includes(text)) as Element;
    const first = rowFor('1 Jan 2025');
    expect(first).toBeTruthy();
    rerender(<WarningsList warnings={[{ ...w, assumedPaid: [...(w.assumedPaid ?? [])].reverse() }]} />);
    expect(rowFor('1 Jan 2025')).toBe(first);
  });

  it('other warnings keep their title and server detail, no list', () => {
    const w: ForecastWarning = { code: 'payroll_past_assumed_paid', source: 'payroll', message: '2 pay dates before today: Oct R 9 000.00' };
    const { container } = render(<WarningsList warnings={[w, many(2)]} />);
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('cash13-warnings').textContent).toContain('2 pay dates before today: Oct R 9 000.00');
  });
});
