// D2 round 6 (h2): a failed load clears the stale state, a thrown error never leaves a flag set.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import { OccupationalLevelCard } from '@/components/payroll/OccupationalLevelCard';
import { VatPeriodLockForm } from '@/components/accounting/sars/VatPeriodLockForm';
import AdminSettings from '../../../pages/admin/settings';
import IntercompanyPage from '../../../pages/accounting/group/intercompany';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to/);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('OccupationalLevelCard', () => {
  const LEVELS = [{ id: 'l1', code: 'TM', name: 'Top management', displayOrder: 1 }];
  it('load empty 500: a plain sentence, no raw text', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<OccupationalLevelCard employeeId="e1" currentLevelId={null} onChange={vi.fn()} />);
    expect(await screen.findByText('Could not load occupational levels - try again')).toBeTruthy();
    noRaw();
  });
  it('save 400 shows the server message and does not call onChange', async () => {
    const onChange = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'PATCH' ? bad400() : ok(LEVELS)));
    render(<OccupationalLevelCard employeeId="e1" currentLevelId={null} onChange={onChange} />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'l1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('save transport error: a plain sentence and the button is usable again', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => { if (init?.method === 'PATCH') throw new TypeError('Failed to fetch'); return ok(LEVELS); });
    render(<OccupationalLevelCard employeeId="e1" currentLevelId={null} onChange={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'l1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Could not save the occupational level/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('VatPeriodLockForm', () => {
  it('a rejecting onLock shows a sentence and re-enables the button', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ totalExceptions: 0 }));
    const { container } = render(<VatPeriodLockForm onLock={vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))} />);
    fireEvent.change(container.querySelector('#vat-lock-periodStart')!, { target: { value: '2026-07-01' } });
    fireEvent.change(container.querySelector('#vat-lock-periodEnd')!, { target: { value: '2026-08-31' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByText('Could not lock the period - try again')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /lock period/i }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('admin settings', () => {
  it('a failing alert-settings load hides the editable forms (Save must not write blanks back)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('alert-settings') ? empty500() : ok({ maintenance_mode: false, registration_enabled: true, default_trial_days: 14, max_companies_per_user: 3, smtp_configured: true })));
    render(<AdminSettings />);
    expect(await screen.findByText('Could not load the alert settings - try again')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save alert settings/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
    noRaw();
  });
});

describe('intercompany', () => {
  const GROUP = { id: 'g1', name: 'Grp', companies: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }] };
  it('a failing transactions load shows a sentence instead of an empty-but-valid view', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('company-groups') ? ok({ items: [GROUP] }) : empty500()));
    render(<IntercompanyPage />);
    expect(await screen.findByText('Could not load intercompany data - try again')).toBeTruthy();
    noRaw();
  });
  it('a failing groups load shows a sentence', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => bad400());
    render(<IntercompanyPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});
