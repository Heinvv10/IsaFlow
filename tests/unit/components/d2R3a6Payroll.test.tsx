/**
 * D2 round 3 (a6): payroll cost centres / leave detail / pay scales / training. Writes were fired without
 * reading the response (or only the failure body was read), a failed (re)load left the previous rows under
 * the new state, and the training page showed its error only inside the closed capture form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { afterWrite, empty500, expectNoJargon, MSG, ok, on, refuse, serve, writeCalls, type Route } from '../helpers/d2R3a6';

const LEAVE_ID = '11111111-2222-3333-4444-555555555555';
const router = vi.hoisted(() => ({ query: { id: '11111111-2222-3333-4444-555555555555' }, push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import CostCentresPage from '../../../pages/payroll/cost-centres/index';
import LeaveDetailPage from '../../../pages/payroll/leave/[id]';
import PayScalesPage from '../../../pages/payroll/pay-scales/index';
import TrainingPage from '../../../pages/payroll/training/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockReset(); router.replace.mockReset(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { cleanup(); });

describe('payroll cost centres', () => {
  const CC = { id: 'cc1', code: 'D2CC', name: 'D2 Centre', parentId: null, isActive: true, notes: null };
  const GL = { id: 'g1', accountCode: '6000', accountName: 'D2 Wages', accountType: 'expense' };
  const base: Route[] = [
    on('GET', '/api/payroll/cost-centres/gl-mappings', () => ok([])),
    on('GET', '/api/payroll/cost-centres?', () => ok([CC])),
    on('GET', 'chart-of-accounts', () => ok([GL])),
  ];

  it('load: refusal -> server message and no rows; empty-body 500 -> plain sentence; a failing mappings list also fails the load', async () => {
    serve(on('GET', '/api/payroll/cost-centres?', () => refuse()), ...base);
    render(<CostCentresPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 Centre')).toBeNull();
    cleanup();
    serve(on('GET', 'gl-mappings', empty500), ...base);
    render(<CostCentresPage />);
    expect(await screen.findByText('Could not load the GL mappings - try again')).toBeDefined();
    expect(screen.queryByText('D2 Centre')).toBeNull();
    expectNoJargon();
  });

  it('create: refusal -> message, typed values kept; empty-body 500 -> plain sentence; good -> clears the form', async () => {
    serve(on('POST', '/api/payroll/cost-centres', () => refuse()), ...base);
    render(<CostCentresPage />);
    await screen.findByText('D2 Centre');
    const code = screen.getByPlaceholderText('Code (e.g. ADMIN)') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'NEWCC' } });
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(code.value).toBe('NEWCC');
    serve(on('POST', '/api/payroll/cost-centres', empty500), ...base);
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByText('Could not create the cost centre - try again')).toBeDefined();
    expectNoJargon();
    serve(on('POST', '/api/payroll/cost-centres', () => ok({})), ...base);
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(code.value).toBe(''));
  });

  it('deactivate: refusal -> message; empty-body 500 -> plain sentence', async () => {
    serve(on('DELETE', '/api/payroll/cost-centres/cc1', () => refuse()), ...base);
    render(<CostCentresPage />);
    fireEvent.click(await screen.findByText('Deactivate'));
    expect(await screen.findByText(MSG)).toBeDefined();
    serve(on('DELETE', '/api/payroll/cost-centres/cc1', empty500), ...base);
    fireEvent.click(screen.getByText('Deactivate'));
    expect(await screen.findByText('Could not change the cost centre status - try again')).toBeDefined();
    expectNoJargon();
  });

  it('reactivate: a refused PATCH shows the message', async () => {
    serve(on('PATCH', '/api/payroll/cost-centres/cc1', () => refuse()), on('GET', '/api/payroll/cost-centres?', () => ok([{ ...CC, isActive: false }])), ...base);
    render(<CostCentresPage />);
    fireEvent.click(await screen.findByText('Reactivate'));
    expect(await screen.findByText(MSG)).toBeDefined();
  });

  it('edit save: refusal -> message and the editor stays open; empty-body 500 -> plain sentence', async () => {
    serve(on('PATCH', '/api/payroll/cost-centres/cc1', () => refuse()), ...base);
    render(<CostCentresPage />);
    fireEvent.click(await screen.findByText('Edit'));
    const save = () => document.querySelector('svg.text-emerald-500')!.closest('button') as HTMLButtonElement;
    fireEvent.click(save());
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByDisplayValue('D2CC')).toBeDefined();
    serve(on('PATCH', '/api/payroll/cost-centres/cc1', empty500), ...base);
    fireEvent.click(save());
    expect(await screen.findByText('Could not save the cost centre - try again')).toBeDefined();
    expectNoJargon();
  });

  it('GL mapping: refusal -> message; empty-body 500 -> plain sentence', async () => {
    serve(on('PUT', 'gl-mapping', () => refuse()), ...base);
    render(<CostCentresPage />);
    await screen.findByText('D2 Centre');
    const select = () => screen.getAllByRole('combobox')[0];
    await waitFor(() => expect((select() as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select(), { target: { value: 'g1' } });
    expect(await screen.findByText(MSG)).toBeDefined();
    serve(on('PUT', 'gl-mapping', empty500), ...base);
    fireEvent.change(select(), { target: { value: 'g1' } });
    expect(await screen.findByText('Could not save the GL mapping - try again')).toBeDefined();
    expectNoJargon();
  });

  it('reload failure after a good write: the old rows are gone and the error is shown, nothing stuck busy', async () => {
    serve(...afterWrite('DELETE', '/api/payroll/cost-centres/cc1', '/api/payroll/cost-centres?'), ...base);
    render(<CostCentresPage />);
    fireEvent.click(await screen.findByText('Deactivate'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 Centre')).toBeNull();
    expect((screen.getByText('Add').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('payroll leave request detail', () => {
  const REQ = { id: LEAVE_ID, employeeName: 'D2 Employee', employeeNumber: 'E1', leaveTypeName: 'Annual', startDate: '2026-02-01',
    endDate: '2026-02-03', days: 3, reason: null, status: 'pending', approvedAt: null, createdAt: '2026-01-01T00:00:00Z' };
  const get = on('GET', `/api/payroll/leave/${LEAVE_ID}`, () => ok(REQ));

  it('load: refusal -> server message; empty-body 500 -> plain sentence', async () => {
    serve(on('GET', '/api/payroll/leave/', () => refuse()));
    render(<LeaveDetailPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', '/api/payroll/leave/', empty500));
    render(<LeaveDetailPage />);
    expect(await screen.findByText('Could not load the leave request - try again')).toBeDefined();
    expectNoJargon();
  });

  it('approve: refusal -> message shown above the still-visible request, with the buttons usable again', async () => {
    serve(on('PUT', `/api/payroll/leave/${LEAVE_ID}`, () => refuse()), get);
    render(<LeaveDetailPage />);
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('D2 Employee (E1)')).toBeDefined();
    await waitFor(() => expect((screen.getByText('Approve').closest('button') as HTMLButtonElement).disabled).toBe(false));
  });

  it('approve: empty-body 500 -> plain sentence', async () => {
    serve(on('PUT', `/api/payroll/leave/${LEAVE_ID}`, empty500), get);
    render(<LeaveDetailPage />);
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText('Could not update the leave request - try again')).toBeDefined();
    expectNoJargon();
  });

  it('approve: written (200) then the reload fails -> the user is told it was updated and the stale request is gone', async () => {
    serve(...afterWrite('PUT', `/api/payroll/leave/${LEAVE_ID}`, `/api/payroll/leave/${LEAVE_ID}`), get);
    render(<LeaveDetailPage />);
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText(/was updated, but could not be reloaded/)).toBeDefined();
    expect(screen.queryByText('D2 Employee (E1)')).toBeNull();
  });

  it('delete: refusal -> message, no redirect; good -> redirects', async () => {
    serve(on('DELETE', `/api/payroll/leave/${LEAVE_ID}`, () => refuse()), get);
    render(<LeaveDetailPage />);
    fireEvent.click(await screen.findByText('Delete'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(router.push).not.toHaveBeenCalled();
    serve(on('DELETE', `/api/payroll/leave/${LEAVE_ID}`, empty500), get);
    fireEvent.click(screen.getByText('Delete'));
    expect(await screen.findByText('Could not delete the leave request - try again')).toBeDefined();
    expectNoJargon();
    serve(on('DELETE', `/api/payroll/leave/${LEAVE_ID}`, () => ok({})), get);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/leave'));
  });
});

describe('payroll pay scales', () => {
  const PS = { id: 'p1', code: 'D2G5', name: 'D2 Grade Five', gradeLevel: 5, minSalary: 1, midSalary: 2, maxSalary: 3, currency: 'ZAR', isActive: true, notes: null };
  const list = on('GET', '/api/payroll/pay-scales', () => ok([PS]));
  const create = async () => {
    render(<PayScalesPage />);
    await screen.findByText('D2 Grade Five');
    fireEvent.change(screen.getByPlaceholderText('Code (G5)'), { target: { value: 'NEW' } });
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'New scale' } });
    fireEvent.click(screen.getByText('Create'));
  };

  it('load: refusal -> message and no rows; empty-body 500 -> plain sentence', async () => {
    serve(on('GET', '/api/payroll/pay-scales', () => refuse()));
    render(<PayScalesPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', '/api/payroll/pay-scales', empty500));
    render(<PayScalesPage />);
    expect(await screen.findByText('Could not load the pay scales - try again')).toBeDefined();
    expectNoJargon();
  });

  it('create: refusal -> message and the typed code is kept; empty-body 500 -> plain sentence', async () => {
    serve(on('POST', '/api/payroll/pay-scales', () => refuse()), list);
    await create();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect((screen.getByPlaceholderText('Code (G5)') as HTMLInputElement).value).toBe('NEW');
    serve(on('POST', '/api/payroll/pay-scales', empty500), list);
    fireEvent.click(screen.getByText('Create'));
    expect(await screen.findByText('Could not create the pay scale - try again')).toBeDefined();
    expectNoJargon();
  });

  it('toggle: refusal -> message and the status is unchanged; empty-body 500 -> plain sentence', async () => {
    serve(on('PATCH', '/api/payroll/pay-scales/p1', () => refuse()), list);
    render(<PayScalesPage />);
    fireEvent.click(await screen.findByText('Active'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    serve(on('PATCH', '/api/payroll/pay-scales/p1', empty500), list);
    fireEvent.click(screen.getByText('Active'));
    expect(await screen.findByText('Could not change the pay scale status - try again')).toBeDefined();
    expectNoJargon();
  });

  it('reload failure after a good toggle: the old rows are gone and the error is shown', async () => {
    serve(...afterWrite('PATCH', '/api/payroll/pay-scales/p1', '/api/payroll/pay-scales'), list);
    render(<PayScalesPage />);
    fireEvent.click(await screen.findByText('Active'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 Grade Five')).toBeNull();
  });
});

describe('payroll training', () => {
  const EV = { id: 'e1', employeeId: 'm1', category: 'short_course', description: 'D2 First Aid', provider: null, nqfLevel: null,
    plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null, costPlanned: 100, costActual: 0, status: 'planned' };
  const EMP = { id: 'm1', employeeNumber: 'E1', firstName: 'D2', lastName: 'Worker' };
  const base: Route[] = [on('GET', '/api/payroll/training-events', () => ok([EV])), on('GET', '/api/payroll/employees', () => ok([EMP]))];

  it('load: refusal -> message visible with the form closed and no rows; empty-body 500 -> plain sentence; failing employees list too', async () => {
    serve(on('GET', '/api/payroll/training-events', () => refuse()), ...base);
    render(<TrainingPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 First Aid')).toBeNull();
    cleanup();
    serve(on('GET', '/api/payroll/employees', empty500), ...base);
    render(<TrainingPage />);
    expect(await screen.findByText('Could not load the employees - try again')).toBeDefined();
    expect(screen.queryByText('D2 First Aid')).toBeNull();
    expectNoJargon();
  });

  const openForm = async () => {
    render(<TrainingPage />);
    await screen.findByText('D2 First Aid');
    fireEvent.click(screen.getByText('New event'));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'm1' } });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'D2 typed description' } });
  };

  it('create: refusal -> message, the form and typed description stay; empty-body 500 -> plain sentence', async () => {
    serve(on('POST', '/api/payroll/training-events', () => refuse()), ...base);
    await openForm();
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect((screen.getByPlaceholderText('Description') as HTMLInputElement).value).toBe('D2 typed description');
    serve(on('POST', '/api/payroll/training-events', empty500), ...base);
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Could not create the training event - try again')).toBeDefined();
    expectNoJargon();
  });

  it('create: written (200) then the reload fails -> form closed, reload error shown, old rows gone', async () => {
    serve(...afterWrite('POST', '/api/payroll/training-events', '/api/payroll/training-events'), ...base);
    await openForm();
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 First Aid')).toBeNull();
    expect(screen.queryByText('Saving...')).toBeNull();
  });

  it('status change: refusal -> message visible with the form closed; empty-body 500 -> plain sentence', async () => {
    serve(on('PATCH', '/api/payroll/training-events/e1', () => refuse()), ...base);
    render(<TrainingPage />);
    await screen.findByText('D2 First Aid');
    const status = () => screen.getAllByRole('combobox')[0];
    fireEvent.change(status(), { target: { value: 'completed' } });
    expect(await screen.findByText(MSG)).toBeDefined();
    serve(on('PATCH', '/api/payroll/training-events/e1', empty500), ...base);
    fireEvent.change(status(), { target: { value: 'cancelled' } });
    expect(await screen.findByText('Could not update the training event - try again')).toBeDefined();
    expectNoJargon();
    expect(writeCalls('PATCH', '/api/payroll/training-events/e1')).toBe(2);
  });
});
