/** The PDF export opens the PDF route over the page's own period and filters. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncomeStatementExportButtons } from '@/components/accounting/reports/IncomeStatementExportButtons';

const base = { periodStart: '2026-04-01', periodEnd: '2026-04-30', costCentreId: '', businessUnitId: '', disabled: false };

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

  it('is disabled with the other exports', () => {
    render(<IncomeStatementExportButtons {...base} disabled />);
    expect((screen.getByRole('button', { name: 'Export PDF' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
