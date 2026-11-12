// The EMP201's ETI rows (wave 5 ET, folded into L2's Emp201EtiSection): the CSV writes the six ETI rows, toFixed(2),
// PAYE Payable last of them; the section shows brought forward, carried forward and the refund only when > 0 (ETI Act
// s9(1), s10).
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { exportEmp201Csv, type EMP201Data } from '@/components/accounting/sars/emp201/emp201Types';
import { Emp201EtiSection } from '@/components/accounting/sars/emp201/Emp201EtiSection';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer', activeCompany: { id: 'c1' } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const data = (carry: EMP201Data['etiCarry']): EMP201Data => ({
  periodStart: '2026-08-01', periodEnd: '2026-08-31', totalPAYE: 300, totalETI: 1200, payePayable: 0, etiCarry: carry, etiWarnings: [],
  totalUIF_employee: 0, totalUIF_employer: 0, totalUIF: 0, totalSDL: 0, employeeCount: 1, totalTaxableRemuneration: 5000,
  totalDeductions: 0, payrollRuns: [],
});

async function csvRows(d: EMP201Data): Promise<string[][]> {
  let blob: Blob | null = null;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:x'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  exportEmp201Csv(d, '2026-08-01', '2026-08-31');
  return (await blob!.text()).split('\n').map((l) => l.split(','));
}

it('the CSV writes the six ETI rows, toFixed(2), with PAYE Payable last, after PAYE', async () => {
  const rows = await csvRows(data({ broughtForward: 900, used: 300, carriedForward: 0, refundClaimable: 1800 }));
  const i = rows.findIndex((r) => r[0] === 'PAYE');
  expect(rows.slice(i + 1, i + 7)).toEqual([
    ['ETI', 'Employment Tax Incentive for the period', '1200.00'],
    ['ETI brought forward', 'Unused ETI from earlier months (ETI Act s9(1))', '900.00'],
    ['ETI used', 'ETI set off against PAYE', '300.00'],
    ['ETI carried forward', 'Unused ETI for the next month', '0.00'],
    ['ETI refund claimable', 'Unused ETI at the end of August or February: claimed on the EMP501 (s10)', '1800.00'],
    ['PAYE Payable', 'PAYE net of ETI used', '0.00'],
  ]);
  // The CSV is not quoted: no field may hold a comma, so every row is exactly three cells.
  expect(rows.slice(i + 1, i + 7).every((r) => r.length === 3)).toBe(true);
});

it('the section shows brought forward, carried forward and the refund only when each is above nil', () => {
  const view = render(<Emp201EtiSection data={data({ broughtForward: 0, used: 300, carriedForward: 0, refundClaimable: 0 })} />);
  expect(screen.getByText('ETI for the period')).toBeTruthy();
  expect(screen.getByText('Less: ETI used (Employment Tax Incentive)')).toBeTruthy();
  for (const label of ['ETI brought forward from earlier months', 'ETI carried forward to next month', 'ETI refund claimable on the EMP501 (s10)']) {
    expect(screen.queryByText(label)).toBeNull();
  }
  view.rerender(<Emp201EtiSection data={data({ broughtForward: 900, used: 300, carriedForward: 600, refundClaimable: 0 })} />);
  expect(screen.getByText('ETI brought forward from earlier months')).toBeTruthy();
  expect(screen.getByText('ETI carried forward to next month')).toBeTruthy();
  expect(screen.queryByText('ETI refund claimable on the EMP501 (s10)')).toBeNull();
  view.rerender(<Emp201EtiSection data={data({ broughtForward: 900, used: 0, carriedForward: 0, refundClaimable: 900 })} />);
  expect(screen.getByText('ETI refund claimable on the EMP501 (s10)')).toBeTruthy();
  expect(screen.queryByText('ETI carried forward to next month')).toBeNull();
  // PAYE payable is the section's last row, bold, as L2 had it.
  expect(screen.getAllByText(/ETI|PAYE payable/).at(-1)!.textContent).toBe('PAYE payable');
});
