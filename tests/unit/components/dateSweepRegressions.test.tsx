/**
 * Regressions from the display-format sweep (PR #836): a date formatter was once handed a count, a
 * quantity, a hash and an input's value, and showed "01 Jan 1970, 02:00", a date instead of a hash
 * prefix, and a blank date input. Each case below is one of those, rendered for real.
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ReportBuilderPreview } from '@/components/accounting/reports/ReportBuilderPreview';
import { EmployeeProfileCard, type Employee } from '@/components/payroll/EmployeeProfileCard';

vi.mock('@/components/accounting/audit/auditSnapshotApi', () => ({
  fmtAmount: (s: string) => s,
  fmtAt: (s: string) => s,
  getData: async () => ({
    total: 1,
    rows: [{ id: 's1', journalId: 'j1', materialHash: 'a3f9c2d41b77e0c5', row: { entry_number: 'JE-1', entry_date: '2026-10-21', source: 'manual', description: 'x', posted_at: '2026-10-21T08:00:00Z' } }],
  }),
}));
import { SnapshotJournals } from '@/components/accounting/audit/SnapshotJournals';

afterEach(cleanup);

const noop = () => undefined;

describe('ReportBuilderPreview cells', () => {
  const columns = [
    { field: 'qty', label: 'Qty', type: 'number' },
    { field: 'when', label: 'When', type: 'date' },
    { field: 'ref', label: 'Ref', type: 'date' },
  ];
  const rows = [{ qty: 1234567, when: '2026-10-21', ref: 'INV-001' }];

  it('shows a number as a grouped number, a date as dd MMM yyyy, and a non-date unchanged', () => {
    render(<ReportBuilderPreview columns={columns} rows={rows} totals={{}} rowCount={1} sort={[]} isLoading={false}
      onRemoveColumn={noop} onSortChange={noop} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/1970/);
    expect(text).toMatch(/1[\s  ]234[\s  ]567/);
    expect(text).toContain('21 Oct 2026');
    expect(text).toContain('INV-001');
  });
});

describe('EmployeeProfileCard date inputs', () => {
  const employee: Employee = {
    id: 'e1', employeeNumber: 'E-1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
    startDate: '2020-01-01', dateOfBirth: '1990-05-20T00:00:00.000Z', endDate: '2026-12-31',
    uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
  };

  it('keeps the YYYY-MM-DD value a date input needs (a display date would leave it blank)', () => {
    const { container } = render(<EmployeeProfileCard employee={employee} onChange={noop} onSave={noop} saving={false} />);
    const values = [...container.querySelectorAll('input[type="date"]')].map((i) => (i as HTMLInputElement).value);
    expect(values).toEqual(['1990-05-20', '2026-12-31']);
  });
});

describe('SnapshotJournals row hash', () => {
  it('shows the first ten characters of the hash, not a date', async () => {
    render(<SnapshotJournals snapshotId="snap-1" />);
    await waitFor(() => expect(screen.getByText('a3f9c2d41b…')).toBeTruthy());
    expect(document.body.textContent).toContain('21 Oct 2026');
  });
});
