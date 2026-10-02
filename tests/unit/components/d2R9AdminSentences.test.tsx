// D2 round 9 (pages/** outside accounting and api): an empty-body 5xx shows the plain sentence the page's own
// catch uses (assertOk's fallback is what ApiRequestError carries), a write whose apiFetch throws is reported,
// and the DB card says why it is unreachable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'u-1' }, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => {
  const value = { activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' };
  return { useCompany: () => value };
});

vi.mock('@/components/admin/users/UserCompaniesTable', () => ({ UserCompaniesTable: () => null }));
vi.mock('@/components/admin/users/UserAuditLog', () => ({ UserAuditLog: () => null }));
vi.mock('@/components/admin/users/UserProfileForm', () => ({ UserProfileForm: () => null }));
vi.mock('@/components/admin/users/LoginAsModal', () => ({ LoginAsModal: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import HomePage from '../../../pages/home';
import WaitlistPage from '../../../pages/admin/waitlist/index';
import AuditPage from '../../../pages/admin/audit';
import UsersPage from '../../../pages/admin/users/index';
import SarsCodesPage from '../../../pages/admin/payroll/sars-codes';
import PlansPage from '../../../pages/admin/billing/plans';
import HealthPage from '../../../pages/admin/health';
import BillingPage from '../../../pages/admin/billing/index';
import UserDetailPage from '../../../pages/admin/users/[id]';
import SettingsPage from '../../../pages/admin/settings';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('loads: an empty 500 says what could not be loaded', () => {
  const cases: Array<[string, () => ReactNode, string]> = [
    ['home', () => <HomePage />, 'Could not load the home page - try again'],
    ['waitlist', () => <WaitlistPage />, 'Could not load the waitlist - try again'],
    ['audit log', () => <AuditPage />, 'Could not load the audit log - try again'],
    ['users', () => <UsersPage />, 'Could not load the users - try again'],
    ['sars codes', () => <SarsCodesPage />, 'Could not load the SARS codes - try again'],
    ['plans', () => <PlansPage />, 'Could not load the plans - try again'],
    ['billing overview', () => <BillingPage />, 'Could not load billing data - try again'],
  ];
  it.each(cases)('%s', async (_n, ui, sentence) => {
    serve((url) => (url.startsWith('/api/admin/companies') ? ok({ items: [] }) : empty500()));
    render(<>{ui()}</>);
    expect(await screen.findByText(sentence)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/Something went wrong|Failed to load/);
    expectNoJargon();
  });
});

describe('waitlist promote', () => {
  const ROW = { id: 'w1', name: 'D2 Person', email: 'd2@example.test', signup_type: 'direct', company_name: 'D2 Co', practice_name: null,
    phone: null, annual_turnover_cents: null, created_at: '2026-01-01T00:00:00Z', promoted_at: null, promoted_company_id: null };
  const open = async (answer: () => Response) => {
    serve(on('POST', '/promote', answer), on('GET', '/api/admin/waitlist', () => ok({ items: [ROW], total: 1, page: 1, limit: 25, total_pages: 1 })));
    render(<WaitlistPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Promote/ }));
    fireEvent.submit(await waitFor(() => { const f = document.querySelector('form'); if (!f) throw new Error('no form'); return f; }));
  };
  it('empty 500: a plain sentence, not "Promotion failed"', async () => {
    await open(empty500);
    expect(await screen.findByText('Could not promote the signup - try again')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/Promotion failed|Could not complete:/);
  });
  it('400: the server message', async () => {
    await open(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
  });
});

describe('users delete', () => {
  const U = { id: 'u-9', email: 'd2u@example.test', first_name: 'D2', last_name: 'User', role: 'admin', status: 'active', company_count: 1,
    primary_company: 'D2 Co', last_login: null, login_count: 0, created_at: '2026-01-01T00:00:00Z' };
  it('empty 500: a plain sentence, not "Delete failed"', async () => {
    serve(on('DELETE', '/api/admin/users/u-9', empty500), on('GET', '/api/admin/users', () => ok({ items: [U], total: 1, page: 1, limit: 25 })));
    render(<UsersPage />);
    fireEvent.click(await screen.findByTitle('Delete user'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Could not delete user - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Delete failed');
  });
});

describe('sars codes writes', () => {
  const REL = { effective_year: 2026, brs_version: '1', released_at: '2026-01-01T00:00:00Z', is_current: false, notes: null, code_count: 1 };
  const CODE = { code: '3601', effective_year: 2026, category: 'income', description: 'D2 income code', status: 'active', foreign_code: null, code_pair: null,
    applicability_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: '1', imported_at: '2026-01-01T00:00:00Z', used_by_companies: 0 };
  const list = on('GET', '/api/admin/payroll/sars-codes', () => ok({ releases: [REL], codes: [CODE], taxYear: 2026 }));
  beforeEach(() => { vi.stubGlobal('confirm', () => true); });

  it('set current over a dropped connection is reported, not an unhandled rejection', async () => {
    const alert = vi.fn(); vi.stubGlobal('alert', alert);
    serve(on('POST', '/release', () => { throw new Error('socket hang up'); }), list);
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByText('Set as current'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not set the current tax year - try again'));
  });
  it('set current, empty 500: the plain sentence', async () => {
    const alert = vi.fn(); vi.stubGlobal('alert', alert);
    serve(on('POST', '/release', empty500), list);
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByText('Set as current'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not set the current tax year - try again'));
  });
  it('mark deprecated over a dropped connection is reported', async () => {
    const alert = vi.fn(); vi.stubGlobal('alert', alert);
    serve(on('PATCH', '/sars-codes/3601', () => { throw new Error('socket hang up'); }), list);
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByTitle('Mark deprecated'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not update the code status - try again'));
  });
  it('mark deprecated, empty 500: the plain sentence', async () => {
    const alert = vi.fn(); vi.stubGlobal('alert', alert);
    serve(on('PATCH', '/sars-codes/3601', empty500), list);
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByTitle('Mark deprecated'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not update the code status - try again'));
  });
});

describe('plans writes', () => {
  const PLAN = { id: 'p1', code: 'd2', name: 'D2 Pro Plan', description: '', monthly_price_cents: 10000, annual_price_cents: 100000, currency: 'ZAR',
    features: {}, limits: {}, is_active: true, display_order: 1, created_at: '2026-01-01T00:00:00Z' };
  const list = on('GET', '/api/admin/billing/plans', () => ok([PLAN]));
  beforeEach(() => { vi.stubGlobal('confirm', () => true); });
  it('save, empty 500: a plain sentence', async () => {
    serve(on('PATCH', '/plans/p1', empty500), list);
    render(<PlansPage />);
    fireEvent.click(await screen.findByTitle('Edit'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Could not save the plan - try again')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/Save failed|Could not complete:/);
  });
  it('archive, empty 500: a plain sentence', async () => {
    serve(on('DELETE', '/plans/p1', empty500), list);
    render(<PlansPage />);
    fireEvent.click(await screen.findByTitle('Archive'));
    expect(await screen.findByText('Could not archive the plan - try again')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/Archive failed|Could not complete:/);
  });
});

describe('settings saves', () => {
  it('empty 500 on save settings says what could not be saved', async () => {
    serve(
      on('PATCH', '/api/admin/settings', empty500),
      on('GET', '/api/admin/settings', () => ok({ maintenance_mode: false })),
      on('GET', '/api/admin/alert-settings', () => ok({ health_alert_email: '', health_alert_webhook_url: '' })),
    );
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Save Settings$|^Save$/ }));
    expect(await screen.findByText('Could not save settings - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Failed to save');
  });
});

describe('health', () => {
  it('an unreachable database states a reason and does not print the raw driver text', async () => {
    const data = {
      db: { status: 'error', latency_ms: 0, size_mb: 0, error: 'connect ECONNREFUSED 10.0.0.5:5432' },
      job_queue: { pending: 0, running: 0, failed: 0, oldest_pending_age_minutes: null },
      email: { sent_24h: 0, failed_24h: 0, success_rate_percent: 100 },
      active_sessions_24h: 0, trials: { expiring_in_7d: 0 }, recent_errors: [], overall_status: 'critical', checked_at: '2026-01-01T00:00:00Z',
    };
    serve(on('GET', '/api/admin/health', () => ok(data)));
    render(<HealthPage />);
    expect(await screen.findByText('Unreachable')).toBeDefined();
    expect(screen.getByText(/The database did not answer the health check query/)).toBeDefined();
    expect(document.body.textContent).not.toContain('ECONNREFUSED');
  });
  it('a reachable database shows no reason line', async () => {
    const data = {
      db: { status: 'ok', latency_ms: 3, size_mb: 10 },
      job_queue: { pending: 0, running: 0, failed: 0, oldest_pending_age_minutes: null },
      email: { sent_24h: 0, failed_24h: 0, success_rate_percent: 100 },
      active_sessions_24h: 0, trials: { expiring_in_7d: 0 }, recent_errors: [], overall_status: 'healthy', checked_at: '2026-01-01T00:00:00Z',
    };
    serve(on('GET', '/api/admin/health', () => ok(data)));
    render(<HealthPage />);
    expect(await screen.findByText('Connected')).toBeDefined();
    expect(document.body.textContent).not.toContain('did not answer');
  });
});

describe('admin user detail', () => {
  const USER = { id: 'u-1', first_name: 'D2', last_name: 'User', email: 'd2u@example.test', phone: null, role: 'admin', status: 'active',
    last_login: null, login_count: 0, created_at: '2026-01-01T00:00:00Z', companies: [], account_type: 'direct', bureaus: [] };
  const open = async (answer: () => Response) => {
    serve(on('POST', '/force-logout', answer), on('GET', '/api/admin/users/u-1', () => ok(USER)), on('GET', '/api/admin/companies', () => ok({ items: [] })));
    render(<UserDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Force Logout/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Click to confirm/ }));
  };
  it('an action with an empty 500 says the user could not be updated, not "Something went wrong"', async () => {
    await open(empty500);
    expect(await screen.findByText('Could not update the user - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Something went wrong');
  });
  it('an action refused with 400 shows the server message', async () => {
    await open(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
  });
});
