/** Wave 6 PSP: the work card's tax status field offers a personal service provider and asks for its entity (company or trust). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { EmployeeWorkCard } from '@/components/payroll/EmployeeWorkCard';
import type { Employee } from '@/components/payroll/EmployeeProfileCard';

vi.mock('@/components/payroll/EmployeeEmailField', () => ({ EmployeeEmailField: () => null }));

const base: Employee = {
  id: 'e1', employeeNumber: 'E-1', firstName: 'Thandi', lastName: 'Nkosi', employmentType: 'contract', startDate: '2026-01-01',
  uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false,
  taxStatus: 'employee', payBasis: 'monthly',
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const choose = (box: string, name: string) => {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: box }));
};
const save = () => fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));

describe('PayrollTaxStatusField on the work card', () => {
  it('no entity field until the status is personal service provider', () => {
    render(<EmployeeWorkCard employee={base} onSaved={vi.fn()} canEditPriced />);
    expect(screen.queryByTestId('psp-entity-field')).toBeNull();
    choose('Personal service provider', 'Tax status');
    expect(screen.getByTestId('psp-entity-field')).toBeTruthy();
  });

  it('a PSP trust saves the status and the entity together', async () => {
    const onSaved = vi.fn();
    render(<EmployeeWorkCard employee={base} onSaved={onSaved} canEditPriced />);
    choose('Personal service provider', 'Tax status');
    choose('Trust (45%)', 'Personal service provider is a');
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ taxStatus: 'personal_service_provider', pspEntityType: 'trust' });
  });

  it('a stored PSP company shows its entity; moving it to employee clears the entity in the same save', async () => {
    render(<EmployeeWorkCard employee={{ ...base, taxStatus: 'personal_service_provider', pspEntityType: 'company' }} onSaved={vi.fn()} canEditPriced />);
    expect(screen.getByText('Company or close corporation (27%)')).toBeTruthy();
    choose('Employee', 'Tax status');
    expect(screen.queryByTestId('psp-entity-field')).toBeNull();
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ taxStatus: 'employee', pspEntityType: null });
  });

  it('company to trust sends the entity alone', async () => {
    render(<EmployeeWorkCard employee={{ ...base, taxStatus: 'personal_service_provider', pspEntityType: 'company' }} onSaved={vi.fn()} canEditPriced />);
    choose('Trust (45%)', 'Personal service provider is a');
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ pspEntityType: 'trust' });
  });

  it('a manager cannot change the entity (priced term)', () => {
    render(<EmployeeWorkCard employee={{ ...base, taxStatus: 'personal_service_provider', pspEntityType: 'trust' }} onSaved={vi.fn()} canEditPriced={false} />);
    expect(screen.getByRole('combobox', { name: 'Personal service provider is a' }).getAttribute('aria-disabled')).toBe('true');
  });
});
