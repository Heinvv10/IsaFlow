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

describe('EmployeeWorkCard', () => {
  it('prompts for a director type on an employee status, and does not change the status by itself', () => {
    render(<EmployeeWorkCard employee={base} onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Set tax status to Director?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /save work terms/i }).hasAttribute('disabled')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no prompt for a permanent employee', () => {
    render(<EmployeeWorkCard employee={{ ...base, employmentType: 'permanent' }} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Set tax status to Director?' })).toBeNull();
  });

  it('accepting the prompt enables save, which PATCHes only the terms', async () => {
    const onSaved = vi.fn();
    render(<EmployeeWorkCard employee={base} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set tax status to Director?' }));
    fireEvent.change(screen.getByLabelText('Hours a week'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/payroll/employees/e1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      taxStatus: 'director', payBasis: 'monthly', hoursPerWeek: 40, hoursPerDay: null, hourlyRate: null, dailyRate: null, occupation: null,
    });
  });

  it('shows the server refusal and does not report a save', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { message: 'hoursPerWeek must be more than 0' } }), { status: 400 }));
    const onSaved = vi.fn();
    render(<EmployeeWorkCard employee={base} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Hours a week'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /save work terms/i }));
    await screen.findByRole('alert');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
