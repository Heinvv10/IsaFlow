/** /payroll/leave: the two list filters carry accessible names (axe select-name, critical). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import LeaveIndexPage from '../../../pages/payroll/leave/index';

useApiJsonOverMock();
afterEach(cleanup);

describe('leave list filters', () => {
  it('are named, and the named controls still drive the filter', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    render(<LeaveIndexPage />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'approved' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by month' }), { target: { value: '3' } });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.lastCall?.[0]).toContain('status=approved&month=3'));
  });
});
