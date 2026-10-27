// Wave 2 Y: the remaining document dates are DateFields. A typed date reaches the API as ISO; text the field refuses
// leaves the date empty, so the form's own check blocks the submit and nothing is posted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';
import { dateInputs, typeDate } from '../../helpers/typeDate';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import NewLeavePage from '../../../pages/payroll/leave/new';
import { VatPeriodLockForm } from '@/components/accounting/sars/VatPeriodLockForm';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockReset(); });
afterEach(cleanup);

describe('leave new', () => {
  const open = async () => {
    serve(
      on('POST', '/api/payroll/leave', () => ok({ id: 'l1' })),
      on('GET', '/api/payroll/employees', () => ok([{ id: 'e1', firstName: 'Ann', lastName: 'Lee', employeeNumber: 'E1' }])),
      on('GET', '/api/payroll/leave/types', () => ok([{ id: 't1', name: 'Annual', isPaid: true }])),
    );
    const { container } = render(<NewLeavePage />);
    await screen.findByText(/Ann Lee/);
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'e1' } });
    fireEvent.change(screen.getByLabelText('Leave Type'), { target: { value: 't1' } });
    const posts = (): unknown[] => vi.mocked(apiFetch).mock.calls
      .filter(([u, i]) => String(u) === '/api/payroll/leave' && (i as RequestInit | undefined)?.method === 'POST')
      .map(([, i]) => JSON.parse(String((i as RequestInit).body)));
    return { container, posts };
  };

  it('names the employee, leave type and notes controls', async () => {
    await open();
    expect(screen.getByLabelText('Leave Type').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Notes (optional)').tagName).toBe('TEXTAREA');
  });

  it('typed dates are posted as ISO', async () => {
    const { container, posts } = await open();
    const [start, end] = dateInputs(container);
    typeDate(start!, '5 Oct 2026');
    typeDate(end!, '07/10/2026');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ startDate: '2026-10-05', endDate: '2026-10-07', days: 3 });
  });

  it('"zz" is refused and blocks the submit', async () => {
    const { container, posts } = await open();
    const [start, end] = dateInputs(container);
    typeDate(start!, 'zz');
    typeDate(end!, '2026-10-07');
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByText('All fields are required')).toBeTruthy();
    expect(start!.getAttribute('aria-invalid')).toBe('true');
    expect(posts()).toHaveLength(0);
  });
});

describe('VatPeriodLockForm dates', () => {
  it('a refused date does not lock the period; a good one does', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ totalExceptions: 0 }));
    const onLock = vi.fn().mockResolvedValue(null);
    const { container } = render(<VatPeriodLockForm onLock={onLock} />);
    typeDate(container.querySelector('#vat-lock-periodStart')!, 'zz');
    typeDate(container.querySelector('#vat-lock-periodEnd')!, '2026-04-30');
    fireEvent.submit(container.querySelector('form')!);
    await Promise.resolve();
    expect(onLock).not.toHaveBeenCalled();
    typeDate(container.querySelector('#vat-lock-periodStart')!, '1 Mar 2026');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onLock).toHaveBeenCalledWith('2026-03-01', '2026-04-30', '', ''));
  });
});
