// Wave 2 Y: a date the field refused must stop the submit, optional dates included. DateField hands the parent
// null for refused text, so without the gate an optional "Effective to" posts an open-ended rate and a job's due
// date posts as empty while "zz" is still on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';
import { dateInputs, typeDate } from '../../helpers/typeDate';

const router = vi.hoisted(() => ({ query: { assetId: 'a1', id: 'j1' } as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/assets/AssetFleetPanel', () => ({ AssetFleetPanel: () => null }));
vi.mock('@/components/assets/AssetDualTrackPanel', () => ({ AssetDualTrackPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import StaffRatesPage from '../../../pages/accounting/practice/staff-rates';
import NewJobPage from '../../../pages/accounting/practice/jobs/new';
import AssetDetailPage from '../../../pages/accounting/assets/[assetId]';
import JobDetailPage from '../../../pages/accounting/practice/jobs/[id]';
import { ClientRateOverrides } from '@/components/practice/ClientRateOverrides';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockReset(); });
afterEach(cleanup);

const posts = (part: string): unknown[] => vi.mocked(apiFetch).mock.calls
  .filter(([u, i]) => String(u).includes(part) && (i as RequestInit | undefined)?.method === 'POST')
  .map(([, i]) => JSON.parse(String((i as RequestInit).body)));
const press = (el: HTMLElement) => fireEvent.click(el);

describe('staff rates', () => {
  const open = async () => {
    serve(on('GET', '/practice/users', () => ok([{ id: 'u1', email: 'a@b.co', fullName: 'Ann Lee' }])), on('POST', '/staff-rates', () => ok({ id: 'r1' })));
    const view = render(<StaffRatesPage />);
    await screen.findByPlaceholderText('e.g. 850.00');
    fireEvent.change(screen.getByPlaceholderText('e.g. 850.00'), { target: { value: '850' } });
    const [from, to] = dateInputs(view.container);
    typeDate(from!, '1 Oct 2026');
    return { to: to!, button: screen.getByRole('button', { name: /Add Rate/ }) };
  };

  it('"zz" in the optional Effective To blocks the POST', async () => {
    const { to, button } = await open();
    typeDate(to, 'zz');
    expect(to.getAttribute('aria-invalid')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    press(button);
    await Promise.resolve();
    expect(posts('/staff-rates')).toHaveLength(0);
  });

  it('a good Effective To posts it, and clearing a refused one lets the rate post open-ended', async () => {
    const { to, button } = await open();
    typeDate(to, 'zz');
    typeDate(to, '');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(button.closest('form')!);
    await waitFor(() => expect(posts('/staff-rates')).toHaveLength(1));
    expect(posts('/staff-rates')[0]).toMatchObject({ effectiveFrom: '2026-10-01' });
  });
});

describe('Enter commits a date like leaving the field', () => {
  it('refused text committed with Enter blocks the submit', async () => {
    serve(on('GET', '/practice/users', () => ok([{ id: 'u1', email: 'a@b.co', fullName: 'Ann Lee' }])));
    const { container } = render(<StaffRatesPage />);
    await screen.findByPlaceholderText('e.g. 850.00');
    const to = dateInputs(container)[1]!;
    fireEvent.change(to, { target: { value: 'zz' } });
    expect((screen.getByRole('button', { name: /Add Rate/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(to, { key: 'Enter' });
    expect((screen.getByRole('button', { name: /Add Rate/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a date typed and committed with Enter reaches the POST as ISO', async () => {
    serve(on('GET', '/practice/users', () => ok([{ id: 'u1', email: 'a@b.co', fullName: 'Ann Lee' }])), on('POST', '/staff-rates', () => ok({ id: 'r1' })));
    const { container } = render(<StaffRatesPage />);
    await screen.findByPlaceholderText('e.g. 850.00');
    fireEvent.change(screen.getByPlaceholderText('e.g. 850.00'), { target: { value: '850' } });
    const [from] = dateInputs(container);
    fireEvent.change(from!, { target: { value: '2 Nov 2026' } });
    fireEvent.keyDown(from!, { key: 'Enter' });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posts('/staff-rates')).toHaveLength(1));
    expect(posts('/staff-rates')[0]).toMatchObject({ effectiveFrom: '2026-11-02' });
  });
});

describe('ClientRateOverrides', () => {
  const open = async () => {
    serve(on('GET', '/staff', () => ok([{ userId: 'u1', email: 'a@b.co', fullName: 'Ann Lee' }])), on('POST', '/rate-overrides', () => ok({ id: 'o1' })));
    const view = render(<ClientRateOverrides clientId="c1" />);
    press(await screen.findByRole('button', { name: /Add|New|Override/i }));
    fireEvent.change(await screen.findByPlaceholderText('0.00'), { target: { value: '500' } });
    fireEvent.change(view.container.querySelector('select')!, { target: { value: 'u1' } });
    const [from, to] = dateInputs(view.container);
    typeDate(from!, '1 Oct 2026');
    return { view, to: to! };
  };

  it('"zz" in Effective To blocks the Save POST', async () => {
    const { to } = await open();
    typeDate(to, 'zz');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    press(save);
    await Promise.resolve();
    expect(posts('/rate-overrides')).toHaveLength(0);
  });

  it('a refusal does not outlive the form: Cancel and reopen leaves Save enabled', async () => {
    const { to } = await open();
    typeDate(to, 'zz');
    press(screen.getByRole('button', { name: 'Cancel' }));
    press(screen.getByRole('button', { name: /Add|New|Override/i }));
    expect((await screen.findByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('new practice job', () => {
  it('"zz" in Due Date blocks the POST instead of creating the job with no due date', async () => {
    serve(
      on('GET', '/practice/clients', () => ok([{ id: 'c1', name: 'Acme' }])),
      on('GET', '/practice/job-categories', () => ok([])),
      on('POST', '/practice/jobs', () => ok({ id: 'j1' })),
    );
    const { container } = render(<NewJobPage />);
    await screen.findByRole('option', { name: 'Acme' });
    fireEvent.change(container.querySelector('select')!, { target: { value: 'c1' } });
    fireEvent.change(container.querySelector('input[type="text"]:not([placeholder="dd MMM yyyy"])')!, { target: { value: 'AFS 2026' } });
    typeDate(dateInputs(container)[0]!, 'zz');
    const create = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    press(create);
    await Promise.resolve();
    expect(posts('/practice/jobs')).toHaveLength(0);
    typeDate(dateInputs(container)[0]!, '30 Nov 2026');
    expect(create.disabled).toBe(false);
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posts('/practice/jobs')).toHaveLength(1));
    expect(posts('/practice/jobs')[0]).toMatchObject({ dueDate: '2026-11-30' });
  });
});

describe('asset disposal', () => {
  const asset = { id: 'a1', name: 'Truck', asset_number: 'A-1', status: 'active' };
  it('"zz" in Disposal Date blocks Confirm Disposal; closing the panel drops the refusal', async () => {
    serve(on('GET', '/api/accounting/assets', () => ok([asset])), on('POST', '/dispose', () => ok({})));
    const { container } = render(<AssetDetailPage />);
    press(await screen.findByRole('button', { name: /Dispose Asset/ }));
    typeDate(dateInputs(container)[0]!, 'zz');
    const confirm = screen.getByRole('button', { name: /Confirm Disposal/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    press(confirm);
    await Promise.resolve();
    expect(posts('/dispose')).toHaveLength(0);
    press(screen.getByRole('button', { name: 'Cancel' }));
    press(screen.getByRole('button', { name: /Dispose Asset/ }));
    expect((within(container).getByRole('button', { name: /Confirm Disposal/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('job detail due date', () => {
  const job = { id: 'j1', title: 'AFS', status: 'new', priority: 'normal', dueDate: '2026-11-30', practiceClientId: 'c1', practiceClientName: 'Acme' };
  const puts = (): unknown[] => vi.mocked(apiFetch).mock.calls
    .filter(([u, i]) => String(u).includes('/practice/jobs/j1') && (i as RequestInit | undefined)?.method === 'PUT')
    .map(([, i]) => JSON.parse(String((i as RequestInit).body)));

  it('shows the API\'s YYYY-MM-DD as a date and saves a retyped one as ISO', async () => {
    serve(on('GET', '/practice/jobs/j1', () => ok(job)), on('GET', '/practice/users', () => ok([])), on('PUT', '/practice/jobs/j1', () => ok(job)));
    const { container } = render(<JobDetailPage />);
    await waitFor(() => expect(dateInputs(container)).toHaveLength(1));
    expect(dateInputs(container)[0]!.value).toBe('30 Nov 2026');
    typeDate(dateInputs(container)[0]!, '15 Dec 2026');
    press(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({ dueDate: '2026-12-15' });
  });

  it('"zz" blocks Save, and leaving the Details tab drops the refusal', async () => {
    serve(on('GET', '/practice/jobs/j1', () => ok(job)), on('GET', '/practice/users', () => ok([])), on('PUT', '/practice/jobs/j1', () => ok(job)));
    const { container } = render(<JobDetailPage />);
    await waitFor(() => expect(dateInputs(container)).toHaveLength(1));
    typeDate(dateInputs(container)[0]!, 'zz');
    const save = screen.getByRole('button', { name: /Save Changes/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    press(save);
    await Promise.resolve();
    expect(puts()).toHaveLength(0);
    press(screen.getByRole('button', { name: /tasks/i }));
    press(screen.getByRole('button', { name: /details/i }));
    expect((screen.getByRole('button', { name: /Save Changes/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
