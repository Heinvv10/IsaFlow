// D2 round 8: the three spots round 7 listed as "still open" now say what failed.
//   CostCentreAssignmentCard saveSingle / saveSplit: a 400 shows the server message, an empty 500 a plain sentence,
//   a thrown request (network) is reported instead of an unhandled rejection;
//   capture/settings handleCopy: a refused clipboard is told to the person;
//   practice/tasks: a failed write's error is not wiped by the reload that follows another action.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 'u-1', role: 'admin' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import { CostCentreAssignmentCard } from '@/components/payroll/CostCentreAssignmentCard';
import CaptureSettingsPage from '../../../pages/accounting/capture/settings';
import TasksPage from '../../../pages/accounting/practice/tasks/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CostCentreAssignmentCard saves', () => {
  const CC = [{ id: 'cc-1', code: 'D2', name: 'D2 Centre', isActive: true }];
  const open = async (write: () => Response) => {
    serve(on('GET', 'cost-centres', () => ok(CC)), on('GET', 'cost-allocations', () => ok([])), on('PATCH', 'cost-centre', write));
    const onChange = vi.fn();
    render(<CostCentreAssignmentCard employeeId="e-1" currentCostCentreId={null} onChange={onChange} />);
    await waitFor(() => expect(document.body.textContent).toContain('D2 Centre'));
    fireEvent.change(document.querySelector('select') as HTMLSelectElement, { target: { value: 'cc-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    return onChange;
  };
  it('400: the server message, nothing reported as saved', async () => {
    const onChange = await open(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('empty 500: a plain sentence', async () => {
    await open(empty500);
    expect(await screen.findByText('Could not save the cost centre - try again')).toBeDefined();
    expectNoJargon();
  });
  it('a request that throws is reported and the button is free again', async () => {
    await open(() => { throw new Error('socket hang up'); });
    expect(await screen.findByText('Could not save the cost centre - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('socket hang up');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('200: onChange runs with the chosen centre and no error shows', async () => {
    const onChange = await open(() => ok({}));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('cc-1'));
    expect(screen.queryByText(/could not save/i)).toBeNull();
  });
});

describe('capture/settings copy', () => {
  const ADDR = { address: 'inbox-d2@capture.test' };
  const copy = async (writeText: () => Promise<void>) => {
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    serve(on('GET', 'inbox-address', () => ok({ inbox: ADDR })));
    render(<CaptureSettingsPage />);
    await screen.findByText(ADDR.address);
    fireEvent.click(screen.getByTitle('Copy address'));
  };
  it('a refused clipboard says so', async () => {
    await copy(() => Promise.reject(new Error('NotAllowedError')));
    expect(await screen.findByText(/Could not copy the address/)).toBeDefined();
  });
  it('a good copy shows no error', async () => {
    const writeText = vi.fn(async () => undefined);
    await copy(writeText);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDR.address));
    expect(screen.queryByText(/Could not copy/)).toBeNull();
  });
});

describe('practice/tasks keeps a write error beside a load error', () => {
  it('a failed load and a failed add are both on screen (neither overwrites the other)', async () => {
    serve(on('GET', 'practice/tasks', () => refuse('D2 load refused')), on('POST', 'practice/tasks', () => refuse('D2 add refused')));
    render(<TasksPage />);
    expect(await screen.findByText('D2 load refused')).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText(/Task title/), { target: { value: 'D2 task' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(await screen.findByText('D2 add refused')).toBeDefined();
    expect(screen.getByText('D2 load refused')).toBeDefined();
  });
  it('the next write clears the previous write error', async () => {
    let n = 0;
    serve(on('GET', 'practice/tasks', () => ok({ tasks: [] })), on('POST', 'practice/tasks', () => (n++ === 0 ? refuse('D2 add refused') : ok({}))));
    render(<TasksPage />);
    fireEvent.change(await screen.findByPlaceholderText(/Task title/), { target: { value: 'D2 task' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(await screen.findByText('D2 add refused')).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText(/Task title/), { target: { value: 'D2 task' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => expect(screen.queryByText('D2 add refused')).toBeNull());
  });
});
