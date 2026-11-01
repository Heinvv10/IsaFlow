/** Each export opens its route over the page's own period and filters; the PDF also hears which comparators are on. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncomeStatementExportButtons } from '@/components/accounting/reports/IncomeStatementExportButtons';

const base = {
  periodStart: '2026-04-01', periodEnd: '2026-04-30', costCentreId: '', businessUnitId: '', disabled: false,
  columns: { prior: false, budget: false },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Export PDF', () => {
  it('opens the PDF route with the period and filters', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<IncomeStatementExportButtons {...base} costCentreId="cc-1" businessUnitId="bu-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(open).toHaveBeenCalledWith(
      '/api/accounting/income-statement-pdf?period_start=2026-04-01&period_end=2026-04-30&cost_centre_id=cc-1&business_unit_id=bu-1',
      '_blank',
    );
  });

  it('sends no filter the page does not have', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<IncomeStatementExportButtons {...base} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(open).toHaveBeenCalledWith('/api/accounting/income-statement-pdf?period_start=2026-04-01&period_end=2026-04-30', '_blank');
  });

  it.each([
    [{ prior: true, budget: false }, 'prior'],
    [{ prior: false, budget: true }, 'budget'],
    [{ prior: true, budget: true }, 'prior%2Cbudget'],
  ])('tells the PDF route the screen has %j on', (columns, value) => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<IncomeStatementExportButtons {...base} columns={columns} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(open).toHaveBeenCalledWith(
      `/api/accounting/income-statement-pdf?period_start=2026-04-01&period_end=2026-04-30&comparators=${value}`, '_blank',
    );
  });

  it('is disabled with the other exports', () => {
    render(<IncomeStatementExportButtons {...base} disabled />);
    expect((screen.getByRole('button', { name: 'Export PDF' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the other exports', () => {
  it('stay in their order, with the PDF last', () => {
    render(<IncomeStatementExportButtons {...base} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Export Excel', 'Export CSV', 'Export PDF']);
  });

  it.each([
    ['Export Excel', 'income-statement-xlsx'],
    ['Export CSV', 'income-statement-export'],
  ])('%s opens its route with the period and filters, and no comparators', (name, route) => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<IncomeStatementExportButtons {...base} costCentreId="cc-1" businessUnitId="bu-1" columns={{ prior: true, budget: true }} />);
    fireEvent.click(screen.getByRole('button', { name }));
    expect(open).toHaveBeenCalledWith(
      `/api/accounting/${route}?period_start=2026-04-01&period_end=2026-04-30&cost_centre_id=cc-1&business_unit_id=bu-1`, '_blank',
    );
  });
});
