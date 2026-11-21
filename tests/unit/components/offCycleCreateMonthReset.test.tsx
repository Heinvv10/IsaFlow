/**
 * Gate item 5 on 06c106a94d: the off-cycle form's amounts belong to the month chosen; changing the month clears them
 * with the selection, so an employee reselected in the new month starts with no amount, never last month's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: {}, push: () => undefined }) }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), assertOk: vi.fn(), apiErrorMessage: (_e: unknown, m: string) => m }));
vi.mock('@/components/ui/Select', () => ({
  Select: ({ id, label, value, options, onChange }: { id: string; label: string; value: string | null; options: Array<{ value: string; label: string }>; onChange: (v: string | null) => void }) => (
    <label>{label}<select id={id} aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">-</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select></label>
  ),
}));
vi.mock('@/components/ui/DateField', () => ({ DateField: () => null }));
vi.mock('@/components/ui/MoneyField', () => ({
  MoneyField: ({ label, value, onChange }: { label: string; value: number | null; onChange: (c: number | null) => void }) => (
    <input aria-label={label} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
  ),
}));
vi.mock('@/components/payroll/offCycle/useOffCycleSources', async (orig) => ({
  ...await orig<object>(),
  useOffCycleSources: () => ({
    runs: [{ id: 'oct', periodYear: 2026, periodMonth: 10 }, { id: 'nov', periodYear: 2026, periodMonth: 11 }],
    offCycle: [], components: [{ id: 'c', name: 'Annual bonus' }], leavers: [], error: '', loading: false,
  }),
  useRunPeople: () => ({ people: [{ employeeId: 'e1', label: 'E1 Thandi Mokoena' }], error: '' }),
}));

import OffCyclePage from '@/../pages/payroll/runs/off-cycle';

afterEach(() => cleanup());

describe('the off-cycle form: a new month', () => {
  it('clears the amounts with the selection: the employee reselected in the new month starts empty', () => {
    render(<OffCyclePage />);
    const month = screen.getByLabelText('Month (its approved regular run)');
    fireEvent.change(month, { target: { value: 'oct' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'E1 Thandi Mokoena' }));
    fireEvent.change(screen.getByLabelText('Bonus for E1 Thandi Mokoena'), { target: { value: '500000' } });
    expect((screen.getByLabelText('Bonus for E1 Thandi Mokoena') as HTMLInputElement).value).toBe('500000');
    fireEvent.change(month, { target: { value: 'nov' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'E1 Thandi Mokoena' }));
    expect((screen.getByLabelText('Bonus for E1 Thandi Mokoena') as HTMLInputElement).value).toBe('');
  });
});
