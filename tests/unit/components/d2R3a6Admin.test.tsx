/**
 * D2 round 3 (a6): admin announcements / job queue / dashboard and the company-settings save fired writes
 * without reading the response (a refusal vanished, or only the first of several writes was checked), and a
 * failed reload left the previous figures on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve, writeCalls, type Route } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => {
  const value = { activeCompany: { id: 'co1' }, loading: false }; // stable identity
  return { useCompany: () => value };
});
vi.mock('@/components/accounting/settings/SettingsSidebar', () => ({ SettingsSidebar: () => <span /> }));
vi.mock('@/components/accounting/settings/DimensionSettings', () => ({ DimensionSettings: () => <span /> }));
vi.mock('@/components/accounting/settings/GeneralTab', () => ({
  GeneralTab: ({ company }: { company: { name: string } }) => <p>{company.name}</p>,
}));
vi.mock('@/components/accounting/settings/DocumentsTab', () => ({
  DocumentsTab: ({ docNumbers }: { docNumbers: { prefix: string }[] }) => <p>{docNumbers.map(d => d.prefix).join(',')}</p>,
}));

import { apiFetch } from '@/lib/apiFetch';
import AnnouncementsPage from '../../../pages/admin/tools/announcements';
import JobQueuePage from '../../../pages/admin/job-queue';
import AdminDashboard from '../../../pages/admin/index';
import CompanySettingsPage from '../../../pages/accounting/company-settings';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('admin announcements', () => {
  const ROW = { id: 'a1', title: 'D2 Maintenance', message: 'm', type: 'info', target: 'all', target_ids: null,
    starts_at: '2026-01-01T08:00:00.000Z', ends_at: null, is_dismissible: true };
  const list = on('GET', '/api/admin/announcements', () => ok({ items: [ROW] }));
  const edit = async () => { fireEvent.click(await screen.findByTitle('Edit')); fireEvent.click(await screen.findByText('Save')); };

  it('save: a refusal shows the message above the open dialog; the dialog stays', async () => {
    serve(on('PATCH', '/api/admin/announcements/a1', () => refuse()), list);
    render(<AnnouncementsPage />);
    await edit();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByRole('alert').className).toContain('fixed');
  });

  it('save: an empty-body 500 gives a plain sentence', async () => {
    serve(on('PATCH', '/api/admin/announcements/a1', empty500), list);
    render(<AnnouncementsPage />);
    await edit();
    expect(await screen.findByText('Could not save the announcement - try again')).toBeDefined();
    expectNoJargon();
  });

  it('save: written (200) then the reload fails -> dialog closed, reload error shown, stale rows gone', async () => {
    let patched = false;
    serve(on('PATCH', '/api/admin/announcements/a1', () => { patched = true; return ok({}); }),
      (u, m) => (patched && m === 'GET' && u.includes('/api/admin/announcements') ? refuse() : undefined), list);
    render(<AnnouncementsPage />);
    await edit();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('D2 Maintenance')).toBeNull();
  });

  it('delete: a refusal shows the message and the row stays; an empty-body 500 a plain sentence', async () => {
    serve(on('DELETE', '/api/admin/announcements/a1', () => refuse()), list);
    render(<AnnouncementsPage />);
    fireEvent.click(await screen.findByTitle('Delete'));
    fireEvent.click(await screen.findByText('Delete'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('D2 Maintenance')).toBeDefined();
    cleanup();
    serve(on('DELETE', '/api/admin/announcements/a1', empty500), list);
    render(<AnnouncementsPage />);
    fireEvent.click(await screen.findByTitle('Delete'));
    fireEvent.click(await screen.findByText('Delete'));
    expect(await screen.findByText('Could not delete the announcement - try again')).toBeDefined();
    expectNoJargon();
  });
});

describe('admin job queue', () => {
  const JOB = { id: 'j1', company_id: null, job_type: 'd2.job.type', payload: {}, status: 'failed', priority: 0, attempts: 1,
    max_attempts: 3, scheduled_at: '2026-01-01T00:00:00Z', started_at: null, completed_at: null, error_message: null, result: null,
    created_at: '2026-01-01T00:00:00Z' };
  const list = on('GET', '/api/admin/job-queue?', () => ok({ jobs: [JOB], total: 7 }));

  it('retry: a refusal shows the server message and is not stuck retrying', async () => {
    serve(on('POST', '/api/admin/job-queue', () => refuse()), list);
    render(<JobQueuePage />);
    fireEvent.click(await screen.findByText('Retry'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
    expect(writeCalls('GET', '/api/admin/job-queue?')).toBe(1);
  });

  it('retry: an empty-body 500 gives a plain sentence', async () => {
    serve(on('POST', '/api/admin/job-queue', empty500), list);
    render(<JobQueuePage />);
    fireEvent.click(await screen.findByText('Retry'));
    expect(await screen.findByText('Could not retry the job - try again')).toBeDefined();
    expectNoJargon();
  });

  it('reload failure: the previous rows and the previous total are cleared', async () => {
    let posted = false;
    serve(on('POST', '/api/admin/job-queue', () => { posted = true; return ok({}); }),
      (u, m) => (posted && m === 'GET' && u.includes('/api/admin/job-queue?') ? refuse() : undefined), list);
    render(<JobQueuePage />);
    await screen.findByText(/7 total jobs/);
    fireEvent.click(await screen.findByText('Retry'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('d2.job.type')).toBeNull();
    expect(screen.queryByText(/7 total jobs/)).toBeNull();
    expect(screen.getByText(/0 total jobs/)).toBeDefined();
  });
});

describe('admin dashboard', () => {
  const D = '2026-01-01T00:00:00Z';
  const STATS = { total_companies: 7741, active_companies: 1, total_users: 1, active_users_30d: 1, mrr_cents: 0, arr_cents: 0, new_signups_30d: 1,
    recent_activity: [] };
  const TRIAL = { id: 't1', name: 'D2 Trial Co', trial_ends_at: D, user_count: 2, days_left: 3, status: 'trial' };
  const base: Route[] = [on('GET', '/api/admin/dashboard-stats', () => ok(STATS)), on('GET', '/api/admin/trials', () => ok([TRIAL]))];

  it('extend trial: a refusal shows the server message', async () => {
    serve(on('POST', '/api/admin/trials', () => refuse()), ...base);
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByText('+7 days'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(writeCalls('GET', '/api/admin/dashboard-stats')).toBe(1);
  });

  it('extend trial: an empty-body 500 gives a plain sentence', async () => {
    serve(on('POST', '/api/admin/trials', empty500), ...base);
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByText('+7 days'));
    expect(await screen.findByText('Could not extend the trial - try again')).toBeDefined();
    expectNoJargon();
  });

  it('extend trial: written (200) then the reload fails -> the previous figures are gone, the error is shown', async () => {
    let posted = false;
    serve(on('POST', '/api/admin/trials', () => { posted = true; return ok({}); }),
      (u, m) => (posted && m === 'GET' && u.includes('dashboard-stats') ? refuse() : undefined), ...base);
    render(<AdminDashboard />);
    await screen.findByText('7741');
    fireEvent.click(await screen.findByText('+7 days'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('7741')).toBeNull();
  });

  it('load: a failing health or trials request (empty 500) no longer breaks the dashboard or prints JSON text', async () => {
    serve(on('GET', '/api/admin/analytics/health', empty500), on('GET', '/api/admin/trials', empty500),
      on('GET', '/api/admin/dashboard-stats', () => ok(STATS)));
    render(<AdminDashboard />);
    expect(await screen.findByText('7741')).toBeDefined();
    expectNoJargon();
  });

  it('load: a stats refusal shows the message, an empty-body 500 a plain sentence', async () => {
    serve(on('GET', '/api/admin/dashboard-stats', () => refuse()));
    render(<AdminDashboard />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', '/api/admin/dashboard-stats', empty500));
    render(<AdminDashboard />);
    expect(await screen.findByText('Could not load the dashboard - try again')).toBeDefined();
    expectNoJargon();
  });
});

describe('company settings save', () => {
  const base = (display: Route = on('GET', 'accounting-settings', () => ok({ key: 'document_display_fields', value: null }))): Route[] => [
    on('GET', '/companies?id=', () => ok({ id: 'co1', name: 'D2 Company (Pty) Ltd' })),
    on('GET', 'type=document-numbers', () => ok([{ documentType: 'invoice', prefix: 'D2PFX', nextNumber: 1 }])),
    display,
  ];
  // open() has already waited for the loads (Save enabled). The prefix is never on screen, so waiting for it only
  // burned the whole find timeout before every save.
  const save = async () => { fireEvent.click(await screen.findByText('Save Changes')); };
  const open = async () => { render(<CompanySettingsPage />); await waitFor(() => expect((screen.getByText('Save Changes').closest('button') as HTMLButtonElement).disabled).toBe(false)); };

  it('company PUT refused: the server message, no "saved" banner, the other writes are not attempted', async () => {
    serve(on('PUT', '/api/accounting/companies', () => refuse()), ...base());
    await open();
    await save();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('Changes saved successfully')).toBeNull();
    expect(writeCalls('PUT', 'document-numbers')).toBe(0);
  });

  it('company PUT empty-body 500: a plain sentence', async () => {
    serve(on('PUT', '/api/accounting/companies', empty500), ...base());
    await open();
    await save();
    expect(await screen.findByText('Could not save the company details - try again')).toBeDefined();
    expectNoJargon();
  });

  it('a refused secondary write (document numbers) is shown and never reported as saved', async () => {
    serve(on('PUT', '/api/accounting/companies', () => ok({})), on('PUT', 'document-numbers', () => refuse()),
      on('PUT', 'accounting-settings', () => ok({})), ...base());
    await open();
    await save();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('Changes saved successfully')).toBeNull();
  });

  it('an empty-body 500 on a secondary write gives a plain sentence', async () => {
    serve(on('PUT', '/api/accounting/companies', () => ok({})), on('PUT', 'document-numbers', empty500),
      on('PUT', 'accounting-settings', () => ok({})), ...base());
    await open();
    await save();
    expect(await screen.findByText(/Company details saved, but some settings could not be saved - try again/)).toBeDefined();
    expectNoJargon();
  });

  it('display fields that failed to load are never overwritten by the defaults on save', async () => {
    serve(on('PUT', '/api/accounting/companies', () => ok({})), on('PUT', 'document-numbers', () => ok({})),
      on('PUT', 'accounting-settings', () => ok({})), ...base(on('GET', 'accounting-settings', () => refuse())));
    await open();
    await save();
    expect(await screen.findByText('Changes saved successfully')).toBeDefined();
    expect(writeCalls('PUT', 'document-numbers')).toBe(1);
    expect(writeCalls('PUT', 'accounting-settings')).toBe(0);
  });

  it('a good save writes everything and reports saved', async () => {
    serve(on('PUT', '/api/accounting/companies', () => ok({})), on('PUT', 'document-numbers', () => ok({})),
      on('PUT', 'accounting-settings', () => ok({})), ...base());
    await open();
    await save();
    expect(await screen.findByText('Changes saved successfully')).toBeDefined();
    expect(writeCalls('PUT', 'accounting-settings')).toBe(1);
  });
});
