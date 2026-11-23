// Parallel-run comparison report: the component-totals and per-employee tables (and the expanded drill-down) become labelled cards below lg.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ParallelRunReportView } from '@/components/payroll/parallelRun/ParallelRunReportView';
import type { ParallelRunComparisonReport } from '@/modules/accounting/services/payroll/payrollParallelRunTypes';

const comp = (component: 'gross' | 'paye', i: number | null, e: number | null) => ({ component, isaflowCents: i, externalCents: e, diffCents: i === null || e === null ? null : i - e });
const report = {
  summary: { employeesIsaflow: 2, employeesExternal: 2, matchedBothSides: 2, matchToTheCent: 1, withVariance: 1, missingInIsaflow: 0, missingInExternal: 0, matchRate: 0.5, componentTotals: [comp('gross', 3000000, 2999000), comp('paye', 600000, 600000)] },
  employees: [
    { employeeNumber: 'E001', employeeName: 'Ann Smith', status: 'variance', maxAbsDiffCents: 1000, components: [comp('gross', 1500000, 1499000), comp('paye', 300000, 300000)] },
    { employeeNumber: 'E002', employeeName: 'Bob Jones', status: 'match', maxAbsDiffCents: 0, components: [comp('gross', 1500000, 1500000)] },
  ],
} as unknown as ParallelRunComparisonReport;

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const labels = (tr: Element) => [...tr.querySelectorAll(':scope > td')].map((td) => td.getAttribute('data-label'));

describe('Parallel-run report on touch', () => {
  it('component totals: labelled cards, the component name is the unlabelled heading cell', () => {
    const { container } = render(<ParallelRunReportView report={report} />);
    const table = container.querySelectorAll('table')[0];
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Component totals', 'IsaFlow', 'External', 'Diff']);
    for (const tr of table.querySelectorAll('tbody tr')) expect(labels(tr)).toEqual([null, 'IsaFlow', 'External', 'Diff']);
  });

  it('employee table: labelled cards; the chevron cell and the employee cell carry no label', () => {
    const { container } = render(<ParallelRunReportView report={report} />);
    const table = container.querySelectorAll('table')[1];
    expect(cls(table)).toContain('table-cards');
    const rows = table.querySelectorAll('tbody > tr');
    expect(rows).toHaveLength(2);
    for (const tr of rows) expect(labels(tr)).toEqual([null, null, 'Status', 'Largest diff']);
  });

  it('empty report: the empty cell is centred in card mode', () => {
    const empty = { ...report, employees: [] } as unknown as ParallelRunComparisonReport;
    render(<ParallelRunReportView report={empty} />);
    const cell = screen.getByText(/Nothing to compare/).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
  });

  it('expanded drill-down: its spacer cell hides and its nested table is labelled cards', () => {
    const { container } = render(<ParallelRunReportView report={report} />);
    fireEvent.click(screen.getByText('E001').closest('tr')!);
    const expandedRow = container.querySelectorAll('table')[1].querySelectorAll(':scope > tbody > tr')[1];
    const [spacer, content] = [...expandedRow.querySelectorAll(':scope > td')];
    expect(cls(spacer)).toContain('max-lg:!hidden');
    const nested = content.querySelector('table')!;
    expect(cls(nested)).toContain('table-cards');
    for (const tr of nested.querySelectorAll('tbody tr')) expect(labels(tr)).toEqual([null, 'IsaFlow', 'External', 'Diff']);
  });
});
