// D2 round 12b: after a create succeeded, a failed navigation is not a failed save. A rejecting push shows no
// "Could not create" sentence, and a push that resolves false frees the button (never stuck on "Saving").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve, writeCalls } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), back: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => { const r = { ...router, isReady: true, replace: vi.fn(), pathname: '/' }; return { useRouter: () => r }; });
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import NewRunPage from '../../../pages/payroll/runs/new';
import NewEmployeePage from '../../../pages/payroll/employees/new';
import NewBatchPage from '../../../pages/payroll/batches/new';
import NewLoanPage from '../../../pages/payroll/loans/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockReset(); vi.mocked(log.warn).mockClear(); });
afterEach(() => { cleanup(); });

const EMP = { id: 'e1', employeeNumber: 'E1', firstName: 'Ann', lastName: 'Lee' };
const text = (c: HTMLElement, i: number, v: string) => fireEvent.change(c.querySelectorAll('input')[i]!, { target: { value: v } });

function fillRun() { /* defaults are valid */ }
function fillEmployee(c: HTMLElement) { text(c, 0, 'Ann'); text(c, 1, 'Lee'); text(c, 2, 'E1'); }
function fillBatch(c: HTMLElement) { fireEvent.click(c.querySelectorAll('button[type="button"]')[1]!); text(c, 0, 'D2 batch'); }
function fillLoan(c: HTMLElement) {
  fireEvent.change(c.querySelector('select')!, { target: { value: 'e1' } });
  text(c, 0, 'L1'); text(c, 2, 'D2 loan'); text(c, 3, '1000');
}

const CASES: Array<[string, () => JSX.Element, string, (c: HTMLElement) => void, string]> = [
  ['new payroll run', () => <NewRunPage />, '/api/payroll/runs', fillRun, 'Could not create the payroll run'],
  ['new employee', () => <NewEmployeePage />, '/api/payroll/employees', fillEmployee, 'Could not create the employee'],
  ['new batch', () => <NewBatchPage />, '/api/payroll/batches', fillBatch, 'Could not create the batch'],
  ['new loan', () => <NewLoanPage />, '/api/payroll/loans', fillLoan, 'Could not create the loan'],
];

describe.each(CASES)('%s: navigation after a successful create', (_n, page, api, fill, failText) => {
  const setup = async () => {
    serve(on('POST', api, () => ok({ id: 'x1' })), on('GET', '/api/payroll/employees', () => ok([EMP])), on('GET', '/api/payroll/components', () => ok([])));
    const { container } = render(page());
    await waitFor(() => expect(container.querySelector('button[type="submit"]')).not.toBeNull());
    if (container.querySelector('select option[value="e1"]') === null && api.endsWith('loans')) await screen.findByText(/Ann/);
    fill(container);
    return container;
  };
  const submit = (c: HTMLElement) => fireEvent.submit(c.querySelector('form')!);

  it('a rejecting push does not report the save as failed and frees the button', async () => {
    router.push.mockRejectedValue(new Error('Route Cancelled'));
    const c = await setup();
    submit(c);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/' + api.split('/payroll/')[1] + '/x1'));
    await waitFor(() => expect((c.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
    expect(document.body.textContent).not.toContain(failText);
    expect(writeCalls('POST', api)).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('a push that resolves false frees the button', async () => {
    router.push.mockResolvedValue(false);
    const c = await setup();
    submit(c);
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    await waitFor(() => expect((c.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
    expect(document.body.textContent).not.toContain(failText);
  });
});
