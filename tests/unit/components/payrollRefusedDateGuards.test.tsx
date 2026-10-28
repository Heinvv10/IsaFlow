/**
 * A refused date reaches onChange as null. Each payroll date control must hold its action button until the text
 * is fixed, never act on "no date": Apply package, bulk Apply, the profile's end date and its date-of-birth bound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ApplyPackageCard } from '@/components/payroll/ApplyPackageCard';
import { EmployeeProfileCard, type Employee } from '@/components/payroll/EmployeeProfileCard';
import BulkUpdatePage from '@/../pages/payroll/employees/bulk-update';

const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('pay-packages')) return reply([{ id: 'p1', code: 'PKG', name: 'Standard', isActive: true }]);
    if (String(url).includes('bulk/preview')) return reply({ matchCount: 2, sample: [] });
    return reply([]);
  });
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
const saveButton = () => screen.getByRole('button', { name: /^save/i }) as HTMLButtonElement;

describe('refused dates hold the action', () => {
  it('Apply package waits for a refused effective-from date', async () => {
    render(<ApplyPackageCard employeeId="e1" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'p1' } });
    const apply = screen.getByRole('button', { name: /apply package/i }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    typeDate(/^Effective from/, '31 Feb 2026');
    expect(apply.disabled).toBe(true);
    typeDate(/^Effective from/, '1 Mar 2026');
    expect(apply.disabled).toBe(false);
  });

  it('bulk Apply waits for a refused effective-from date, after a preview that would allow it', async () => {
    render(<BulkUpdatePage />);
    fireEvent.click(screen.getByRole('button', { name: /^preview/i }));
    const apply = await screen.findByRole('button', { name: /apply to 2 employees/i }) as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    typeDate(/^Effective from/, '31 Feb 2026');
    expect(apply.disabled).toBe(true);
    typeDate(/^Effective from/, '1 Mar 2026');
    expect(apply.disabled).toBe(false);
  });

  it('a refused end date disables Save and is not passed on', () => {
    const onChange = vi.fn();
    render(<EmployeeProfileCard employee={EMP} onChange={onChange} onSave={vi.fn()} saving={false} />);
    typeDate('End date', '31 Feb 2026');
    expect(saveButton().disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    typeDate('End date', '1 Mar 2026');
    expect(saveButton().disabled).toBe(false);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ endDate: '2026-03-01' }));
  });

  it('a refused end date text and error are cleared when switching to another employee with no end date', () => {
    const { rerender } = render(<EmployeeProfileCard employee={EMP} onChange={vi.fn()} onSave={vi.fn()} saving={false} />);
    typeDate('End date', '31 Feb 2026');
    expect(screen.getByLabelText('End date').getAttribute('aria-invalid')).toBe('true');
    rerender(<EmployeeProfileCard employee={{ ...EMP, id: 'e2', firstName: 'Bo' }} onChange={vi.fn()} onSave={vi.fn()} saving={false} />);
    const end = screen.getByLabelText('End date') as HTMLInputElement;
    expect(end.value).toBe('');
    expect(end.getAttribute('aria-invalid')).toBe('false');
    expect(saveButton().disabled).toBe(false);
  });

  it('a refused date of birth is cleared from the screen when switching employees', () => {
    const { rerender } = render(<EmployeeProfileCard employee={EMP} onChange={vi.fn()} onSave={vi.fn()} saving={false} />);
    typeDate('Date of birth', '01 Jan 2099');
    expect(screen.getByText('Date of birth cannot be in the future.')).toBeTruthy();
    rerender(<EmployeeProfileCard employee={{ ...EMP, id: 'e2' }} onChange={vi.fn()} onSave={vi.fn()} saving={false} />);
    expect(screen.queryByText('Date of birth cannot be in the future.')).toBeNull();
    expect((screen.getByLabelText('Date of birth') as HTMLInputElement).value).toBe('');
  });

  it('clearing the profile end date reports undefined (an optional date may be emptied)', () => {
    const onChange = vi.fn();
    render(<EmployeeProfileCard employee={{ ...EMP, endDate: '2026-03-01' }} onChange={onChange} onSave={vi.fn()} saving={false} />);
    expect((screen.getByLabelText('End date') as HTMLInputElement).value).not.toBe('');
    typeDate('End date', '');
    expect(saveButton().disabled).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(expect.objectContaining({ endDate: undefined }));
  });

  it('clearing the bulk "Effective from" omits effectiveFrom from the apply body', async () => {
    render(<BulkUpdatePage />);
    fireEvent.click(screen.getByRole('button', { name: /^preview/i }));
    const apply = await screen.findByRole('button', { name: /apply to 2 employees/i }) as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    typeDate(/^Effective from/, '');
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('bulk/apply'))).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('bulk/apply'))!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).not.toHaveProperty('effectiveFrom');
  });

  it('a date of birth in the future is refused with the bound message', () => {
    const onChange = vi.fn();
    render(<EmployeeProfileCard employee={EMP} onChange={onChange} onSave={vi.fn()} saving={false} />);
    typeDate('Date of birth', '01 Jan 2099');
    expect(screen.getByText('Date of birth cannot be in the future.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a refused date does not carry over to another employee', () => {
    const { rerender } = render(<EmployeeProfileCard employee={EMP} onChange={vi.fn()} onSave={vi.fn()} saving={false} />);
    typeDate('End date', '31 Feb 2026');
    expect(saveButton().disabled).toBe(true);
    rerender(<EmployeeProfileCard employee={{ ...EMP, id: 'e2', firstName: 'Bo' }} onChange={vi.fn()} onSave={vi.fn()} saving={false} />);
    expect(saveButton().disabled).toBe(false);
  });
});
