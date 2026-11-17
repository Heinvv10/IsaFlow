// Wave 6 EF: the EMP201 page names the runs it leaves out or cannot reconcile (`runWarnings`: an approved/paid run with
// no approval time; a run whose line UIF split differs from its header), above the form's figures, as notes.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { EMP201Data } from '@/components/accounting/sars/emp201/emp201Types';
import { Emp201ReturnForm } from '@/components/accounting/sars/emp201/Emp201ReturnForm';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer', activeCompany: { id: 'c1' } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const data = (runWarnings?: string[]): EMP201Data => ({
  periodStart: '2028-10-01', periodEnd: '2028-10-31', totalPAYE: 0, totalETI: 0, payePayable: 0,
  etiCarry: { broughtForward: 0, used: 0, carriedForward: 0, refundClaimable: 0 }, etiWarnings: [], runWarnings,
  totalUIF_employee: 0, totalUIF_employer: 0, totalUIF: 0, totalSDL: 0, employeeCount: 0, totalTaxableRemuneration: 0,
  totalDeductions: 0, payrollRuns: [],
});

const W = 'The approved pay run for 2028-10 has no approval time (approved_at or grandfathered), so it is not final and is not on this EMP201. Reopen it and approve it again.';

it('shows each run warning as a note in the form', () => {
  render(<Emp201ReturnForm data={data([W, 'The pay run for 2028-09 stores UIF of R1200.00 on its header but R1000.00 on its lines'])} />);
  const box = screen.getByTestId('emp201-run-warnings');
  const notes = box.querySelectorAll('[role="note"]');
  expect(Array.from(notes, (n) => n.textContent)).toEqual([W, 'The pay run for 2028-09 stores UIF of R1200.00 on its header but R1000.00 on its lines']);
});

it('renders nothing when there is none, or when an older API omits the field', () => {
  render(<Emp201ReturnForm data={data([])} />);
  expect(screen.queryByTestId('emp201-run-warnings')).toBeNull();
  cleanup();
  render(<Emp201ReturnForm data={data(undefined)} />);
  expect(screen.queryByTestId('emp201-run-warnings')).toBeNull();
});
