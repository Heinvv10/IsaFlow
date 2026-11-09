/** EmployeeWorkCard: the director prompt (grill 24) never changes the status by itself; save sends only the terms. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { EmployeeWorkCard } from '@/components/payroll/EmployeeWorkCard';
import type { Employee } from '@/components/payroll/EmployeeProfileCard';

const base: Employee = {
  id: 'e1', employeeNumber: 'E-1', firstName: 'Thandi', lastName: 'Nkosi', employmentType: 'director', startDate: '2026-01-01',
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

describe('EmployeeWorkCard for a manager (no priced terms)', () => {
  it('disables status, basis and rates with a hint, hides the director button, and leaves hours and occupation editable', () => {
    render(<EmployeeWorkCard employee={base} onSaved={vi.fn()} canEditPriced={false} />);
    expect(screen.getByTestId('priced-terms-hint').textContent).toMatch(/owner or admin/);
    expect((screen.getByLabelText('Hourly rate (R)') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Daily rate (R)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Set tax status to Director?' })).toBeNull();
    expect((screen.getByLabelText('Hours a week') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Occupation') as HTMLInputElement).disabled).toBe(false);
  });

  it('an owner sees no hint and the fields are enabled', () => {
    render(<EmployeeWorkCard employee={base} onSaved={vi.fn()} canEditPriced />);
    expect(screen.queryByTestId('priced-terms-hint')).toBeNull();
    expect((screen.getByLabelText('Hourly rate (R)') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('EmployeeWorkCard', () => {
  it('prompts for a director type on an employee status, and does not change the status by itself', () => {
    render(<EmployeeWorkCard employee={base} onSaved={vi.fn()} canEditPriced />);
    expect(screen.getByRole('button', { name: 'Set tax status to Director?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /save work terms/i }).hasAttribute('disabled')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no prompt for a permanent employee', () => {
    render(<EmployeeWorkCard employee={{ ...base, employmentType: 'permanent' }} onSaved={vi.fn()} canEditPriced />);
    expect(screen.queryByRole('button', { name: 'Set tax status to Director?' })).toBeNull();
  });

  it('accepting the prompt enables save, which PATCHes only the terms', async () => {
    const onSaved = vi.fn();
    render(<EmployeeWorkCard employee={base} onSaved={onSaved} canEditPriced />);
    fireEvent.click(screen.getByRole('button', { name: 'Set tax status to Director?' }));
    fireEvent.change(screen.getByLabelText('Hours a week'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/payroll/employees/e1');
    expect(init.method).toBe('PATCH');
    // Only what changed: nothing else rides along, so an unrelated term is never rewritten.
    expect(JSON.parse(init.body)).toEqual({ taxStatus: 'director', hoursPerWeek: 40 });
  });

  it('an occupation-only edit sends the occupation alone (no priced term, no payroll lock)', async () => {
    render(<EmployeeWorkCard employee={{ ...base, employmentType: 'permanent' }} onSaved={vi.fn()} canEditPriced />);
    fireEvent.change(screen.getByLabelText('Occupation'), { target: { value: ' Clerk ' } });
    fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ occupation: 'Clerk' });
  });

  it('loads non-default stored terms into the fields', () => {
    render(<EmployeeWorkCard employee={{
      ...base, employmentType: 'permanent', taxStatus: 'independent_contractor', payBasis: 'hourly', hoursPerWeek: 45, hoursPerDay: 9,
      hourlyRate: 185.5, dailyRate: 900, occupation: 'Welder',
    }} onSaved={vi.fn()} canEditPriced />);
    expect((screen.getByLabelText('Hours a week') as HTMLInputElement).value).toBe('45');
    expect((screen.getByLabelText('Hours a day') as HTMLInputElement).value).toBe('9');
    expect((screen.getByLabelText('Hourly rate (R)') as HTMLInputElement).value).toBe('185.5');
    expect((screen.getByLabelText('Daily rate (R)') as HTMLInputElement).value).toBe('900');
    expect((screen.getByLabelText('Occupation') as HTMLInputElement).value).toBe('Welder');
    expect(screen.getByText('Independent contractor')).toBeTruthy();
    expect(screen.getByText('Hourly')).toBeTruthy();
  });

  it('reports what the server stored, not what was typed', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { occupation: 'Clerk (server)', hoursPerWeek: 40 } }), { status: 200 }));
    const onSaved = vi.fn();
    render(<EmployeeWorkCard employee={{ ...base, employmentType: 'permanent' }} onSaved={onSaved} canEditPriced />);
    fireEvent.change(screen.getByLabelText('Occupation'), { target: { value: 'Clerk' } });
    fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0]![0]).toMatchObject({ occupation: 'Clerk (server)', hoursPerWeek: 40, taxStatus: 'employee' });
  });

  it('text that is not a number is refused in the card and nothing is sent (it would clear the value as null)', () => {
    render(<EmployeeWorkCard employee={{ ...base, employmentType: 'permanent', hourlyRate: 120 }} onSaved={vi.fn()} canEditPriced />);
    fireEvent.change(screen.getByLabelText('Hourly rate (R)'), { target: { value: '12,5x' } });
    fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/Hourly rate must be a number/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server refusal and does not report a save', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { message: 'hoursPerWeek must be more than 0' } }), { status: 400 }));
    const onSaved = vi.fn();
    render(<EmployeeWorkCard employee={base} onSaved={onSaved} canEditPriced />);
    fireEvent.change(screen.getByLabelText('Hours a week'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));
    await screen.findByRole('alert');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
