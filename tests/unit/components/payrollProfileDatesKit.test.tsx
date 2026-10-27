/**
 * Payroll profile dates on the kit's DateField: a refused date (reported as null, valid=false) must block the
 * save / apply / assign / POST, never be saved as "no date". The runs list renders cards below md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'manager' }) }));
vi.mock('@/components/payroll/TaxDirectiveEmployeeSelect', () => ({
  useDirectiveEmployees: () => ({ employees: [{ id: 'e1', firstName: 'Ann', lastName: 'Lee', taxNumber: '123' }], loading: false, error: '', reload: vi.fn() }),
  DirectiveEmployeeSelect: ({ onChange }: { onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void }) => (
    <select aria-label="Employee" onChange={onChange}><option value="" /><option value="e1">Ann Lee</option></select>
  ),
}));

import { CreateTaxDirectiveModal } from '@/components/payroll/TaxDirectiveComponents';
import { EmployeeProfileCard, type Employee } from '@/components/payroll/EmployeeProfileCard';
import { EmployeeComponentsCard } from '@/components/payroll/EmployeeComponentsCard';
import RunsPage from '@/../pages/payroll/runs/index';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const typeDate = (label: string | RegExp, text: string) => {
  const el = screen.getByLabelText(label);
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
};
const EMP: Employee = {
  id: 'e1', employeeNumber: 'E1', firstName: 'Ann', lastName: 'Lee', employmentType: 'permanent', startDate: '2026-01-01',
  uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
};

describe('tax directive dates', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'e1' } });
    fireEvent.change(screen.getByLabelText(/Gross Amount/), { target: { value: '1000' } });
  };
  it('a refused effective date blocks the POST', async () => {
    render(<CreateTaxDirectiveModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fill();
    typeDate(/^Effective Date/, '31 Feb 2026');
    fireEvent.submit(screen.getByRole('button', { name: /create directive/i }).closest('form')!);
    expect(await screen.findByText('Fix the dates marked in red before saving')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('tax-directives'))).toHaveLength(0);
  });
  it('a refused optional date also blocks, instead of posting without it', async () => {
    render(<CreateTaxDirectiveModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fill();
    typeDate(/^Effective Date/, '2026-03-01');
    typeDate('Expiry Date', 'next-ish');
    fireEvent.submit(screen.getByRole('button', { name: /create directive/i }).closest('form')!);
    expect(await screen.findByText('Fix the dates marked in red before saving')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('tax-directives'))).toHaveLength(0);
  });
  it('valid dates post as ISO', async () => {
    render(<CreateTaxDirectiveModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fill();
    typeDate(/^Effective Date/, '01 Mar 2026');
    fireEvent.submit(screen.getByRole('button', { name: /create directive/i }).closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('tax-directives'))).toHaveLength(1));
    const body = JSON.parse(String((fetchMock.mock.calls.find(([u]) => String(u).includes('tax-directives'))![1] as RequestInit).body));
    expect(body.effective_date).toBe('2026-03-01');
    expect(body.expiry_date).toBeUndefined();
  });
});

describe('profile and assignment dates', () => {
  it('a refused date of birth disables Save until it is fixed', () => {
    const onChange = vi.fn();
    render(<EmployeeProfileCard employee={EMP} onChange={onChange} onSave={vi.fn()} saving={false} />);
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    typeDate('Date of birth', '31 Feb 1980');
    expect(save.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    typeDate('Date of birth', '1 Feb 1980');
    expect(save.disabled).toBe(false);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dateOfBirth: '1980-02-01' }));
  });
  it('a refused effective-from date disables Assign', () => {
    render(<EmployeeComponentsCard components={[]} assignments={[]} newComponentId="c1" newAmount="10" newFrom="2026-03-01"
      newIsRecurring onNewComponentId={vi.fn()} onNewAmount={vi.fn()} onNewFrom={vi.fn()} onNewIsRecurring={vi.fn()}
      onAssign={vi.fn()} onEnd={vi.fn()} adding={false} />);
    const assign = screen.getByRole('button', { name: /assign/i }) as HTMLButtonElement;
    expect(assign.disabled).toBe(false);
    typeDate(/^Effective from/, '31 Feb 2026');
    expect(assign.disabled).toBe(true);
  });
});

describe('payroll runs at 390', () => {
  it('renders a card per run with period, status, employees and Net, alongside the md+ table', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [
      { id: 'r1', periodMonth: 9, periodYear: 2026, status: 'approved', totalGross: 75000, totalPaye: 19966, totalNet: 41681, employeeCount: 3, journalEntryId: null },
    ] }), { status: 200 }));
    render(<RunsPage />);
    const list = await screen.findByRole('list', { name: 'Payroll runs' });
    expect(list.className).toContain('md:hidden');
    expect(list.textContent).toContain('Sep 2026');
    expect(list.textContent).toContain('approved');
    expect(list.textContent).toContain('Net');
    expect(list.textContent).toMatch(/41[\s ]681/);
    expect(document.querySelector('table')!.parentElement!.className).toContain('hidden md:block');
  });
});
