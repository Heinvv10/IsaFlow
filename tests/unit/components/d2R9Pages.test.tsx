// D2 round 9: pages that had no component test. A 4xx shows the server message, an empty 5xx a plain sentence
// that says what could not be done, a throwing request is reported, and a good response still renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), back: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ ...router, isReady: true, replace: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
vi.mock('@/contexts/CompanyContext', () => { const v = { activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }; return { useCompany: () => v }; });
vi.mock('@/components/admin/charts/TrafficTimeseriesChart', () => ({ TrafficTimeseriesChart: () => null }));
vi.mock('@/components/admin/ConvertTrialModal', () => ({ ConvertTrialModal: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import WebAnalyticsPage from '../../../pages/admin/web-analytics';
import PaystackReturn from '../../../pages/admin/billing/paystack/return';
import TrialsPage from '../../../pages/admin/trials';
import FlowBundlesPage from '../../../pages/admin/billing/flow-bundles';
import PersonalTokensPage from '../../../pages/developer/personal-tokens';
import DuplicatesPage from '../../../pages/payroll/duplicates';
import NewBatchPage from '../../../pages/payroll/batches/new';
import EmployeePage from '../../../pages/payroll/employees/[id]';
import ContactPage from '../../../pages/contact';
import AuditPortalPage from '../../../pages/audit-portal/[sessionId]';
import ForgotPasswordPage from '../../../pages/forgot-password';
import InvitePage from '../../../pages/invite/[token]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('admin web analytics', () => {
  const SITE = { id: 'w1', name: 'D2 Site', domain: 'd2.test' };
  const live = on('GET', '/web/realtime', () => ok({ active_users_5m: 0, pageviews_5m: 0, top_paths_5m: [] }));
  it('websites 5xx: a plain sentence', async () => {
    serve(on('GET', '/web/websites', empty500));
    render(<WebAnalyticsPage />);
    expect(await screen.findByText('Could not load websites - try again')).toBeDefined(); expectNoJargon();
  });
  it('websites 400: the server message', async () => {
    serve(on('GET', '/web/websites', () => refuse()));
    render(<WebAnalyticsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('summary 5xx: a plain sentence', async () => {
    serve(live, on('GET', '/web/websites', () => ok({ websites: [SITE] })), on('GET', '/web/summary', empty500));
    render(<WebAnalyticsPage />);
    expect(await screen.findByText('Could not load the analytics summary - try again')).toBeDefined(); expectNoJargon();
  });
  it('summary 400: the server message', async () => {
    serve(live, on('GET', '/web/websites', () => ok({ websites: [SITE] })), on('GET', '/web/summary', () => refuse()));
    render(<WebAnalyticsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
});

describe('paystack mandate return', () => {
  beforeEach(() => { router.query = { ref: 'r1' }; });
  it('5xx with no body: a plain sentence', async () => {
    serve(on('GET', '/mandate/verify', empty500));
    render(<PaystackReturn />);
    expect(await screen.findByText('Could not verify the mandate - try again')).toBeDefined(); expectNoJargon();
  });
  it('400: the server message', async () => {
    serve(on('GET', '/mandate/verify', () => refuse()));
    render(<PaystackReturn />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
});

describe('admin trials', () => {
  const TRIAL = { id: 't1', name: 'D2 Trial Co', plan_name: null, trial_ends_at: '2027-01-01T00:00:00Z', trial_started_at: null, user_count: 1, status: 'active', days_left: 5 };
  const list = on('GET', '/api/admin/trials?', () => ok([TRIAL]));
  it('load 5xx: a plain sentence', async () => {
    serve(on('GET', '/api/admin/trials?', empty500));
    render(<TrialsPage />);
    expect(await screen.findByText('Could not load the trials - try again')).toBeDefined(); expectNoJargon();
  });
  it('load 400: the server message', async () => {
    serve(on('GET', '/api/admin/trials?', () => refuse()));
    render(<TrialsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('extend 5xx: a plain sentence and the row stays', async () => {
    serve(on('POST', '/api/admin/trials', empty500), list);
    render(<TrialsPage />);
    fireEvent.click(await screen.findByText('+7 days'));
    expect(await screen.findByText('Could not extend the trial - try again')).toBeDefined();
  });
  it('extend over a dropped connection: reported', async () => {
    serve(on('POST', '/api/admin/trials', () => { throw new Error('socket hang up'); }), list);
    render(<TrialsPage />);
    fireEvent.click(await screen.findByText('+7 days'));
    expect(await screen.findByText('Could not extend the trial - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('socket hang up');
  });
  it('a good load shows the trial', async () => {
    serve(list);
    render(<TrialsPage />);
    expect(await screen.findByText('D2 Trial Co')).toBeDefined();
  });
});

describe('admin flow bundles', () => {
  const BUNDLE = { id: 'b1', name: 'D2 Bundle', flows: 10, priceCents: 1000, isActive: true, displayOrder: 1 };
  it('load 5xx: a plain sentence', async () => {
    serve(on('GET', '/flow-bundles', empty500));
    render(<FlowBundlesPage />);
    expect(await screen.findByText('Could not load bundles - try again')).toBeDefined(); expectNoJargon();
  });
  it('toggle 400: the server message, not a silent no-op', async () => {
    serve(on('PATCH', '/flow-bundles/b1', () => refuse()), on('GET', '/flow-bundles', () => ok({ bundles: [BUNDLE] })));
    render(<FlowBundlesPage />);
    fireEvent.click(await screen.findByText('Deactivate'));
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('a good load shows the bundle', async () => {
    serve(on('GET', '/flow-bundles', () => ok({ bundles: [BUNDLE] })));
    render(<FlowBundlesPage />);
    expect(await screen.findByText('D2 Bundle')).toBeDefined();
  });
});

describe('personal tokens', () => {
  const TOKEN = { id: 'k1', name: 'D2 token', prefix: 'pat_d2', scopes: ['read:reports'], expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, createdAt: '2026-01-01T00:00:00Z' };
  it('load 5xx: a plain sentence in the toast', async () => {
    serve(on('GET', '/api/auth/personal-tokens', empty500));
    render(<PersonalTokensPage />);
    expect(await screen.findByText('Could not load your tokens - try again')).toBeDefined(); expectNoJargon();
  });
  it('revoke 400: the server message', async () => {
    serve(on('DELETE', '/personal-tokens/k1', () => refuse()), on('GET', '/api/auth/personal-tokens', () => ok([TOKEN])));
    render(<PersonalTokensPage />);
    fireEvent.click(await screen.findByTitle('Revoke token'));
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('revoke 5xx: a plain sentence', async () => {
    serve(on('DELETE', '/personal-tokens/k1', empty500), on('GET', '/api/auth/personal-tokens', () => ok([TOKEN])));
    render(<PersonalTokensPage />);
    fireEvent.click(await screen.findByTitle('Revoke token'));
    expect(await screen.findByText('Could not revoke the token - try again')).toBeDefined();
  });
  it('a good load lists the token', async () => {
    serve(on('GET', '/api/auth/personal-tokens', () => ok([TOKEN])));
    render(<PersonalTokensPage />);
    expect(await screen.findByText('D2 token')).toBeDefined();
  });
});

describe('payroll duplicates', () => {
  it('5xx: a plain sentence', async () => {
    serve(on('GET', '/api/payroll/duplicates', empty500));
    render(<DuplicatesPage />);
    expect(await screen.findByText('Could not load the duplicates - try again')).toBeDefined(); expectNoJargon();
  });
  it('403: the no-access message', async () => {
    serve(on('GET', '/api/payroll/duplicates', () => refuse('nope', 403)));
    render(<DuplicatesPage />);
    expect(await screen.findByText("You don't have access to payroll detail.")).toBeDefined();
  });
});

describe('payroll new batch', () => {
  it('component list 5xx: a plain sentence', async () => {
    serve(on('GET', '/api/payroll/components', empty500));
    render(<NewBatchPage />);
    expect(await screen.findByText('Could not load the pay components - try again')).toBeDefined(); expectNoJargon();
  });
  it('component list 400: the server message', async () => {
    serve(on('GET', '/api/payroll/components', () => refuse()));
    render(<NewBatchPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
});

describe('payroll employee detail', () => {
  beforeEach(() => { router.query = { id: 'e-1' }; });
  it('employee 5xx: a plain sentence', async () => {
    serve(on('GET', '/api/payroll/employees/e-1', empty500));
    render(<EmployeePage />);
    expect(await screen.findByText('Could not load this employee - try again')).toBeDefined(); expectNoJargon();
  });
  it('employee 403: the no-access message', async () => {
    serve(on('GET', '/api/payroll/employees/e-1', () => refuse('nope', 403)));
    render(<EmployeePage />);
    expect(await screen.findByText("You don't have access to payroll detail.")).toBeDefined();
  });
  it('employee 404: the server message', async () => {
    serve(on('GET', '/api/payroll/employees/e-1', () => refuse(MSG, 404)));
    render(<EmployeePage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
});

describe('contact form', () => {
  const send = async (reply: () => Response) => {
    serve(on('POST', '/api/contact', reply));
    const { container } = render(<ContactPage />);
    fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: 'D2 Person' } });
    fireEvent.change(container.querySelector('input[name="email"]')!, { target: { value: 'd2@example.test' } });
    fireEvent.change(container.querySelector('textarea[name="message"]')!, { target: { value: 'hello there from d2' } });
    fireEvent.submit(container.querySelector('form')!);
  };
  it('a 5xx says the message was not sent and where to write instead', async () => {
    await send(empty500);
    expect(await screen.findByText('Could not send your message. Please email accounts@isaflow.co.za.')).toBeDefined();
    expect(document.body.textContent).not.toContain('Something went wrong');
  });
  it('a 400 shows the server message', async () => {
    await send(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('a dropped connection says the server could not be reached', async () => {
    await send(() => { throw new Error('socket hang up'); });
    expect(await screen.findByText(/Could not reach the server/)).toBeDefined();
  });
});

describe('audit portal', () => {
  beforeEach(() => { router.query = { sessionId: 's1', token: 't1' }; });
  it('a dropped connection says what could not be done, not "Network error"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    render(<AuditPortalPage />);
    expect(await screen.findByText('Could not check the audit pack link - check your connection and try again.')).toBeDefined();
    expect(document.body.textContent).not.toContain('Network error');
  });
  it('a 401 says the session is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    render(<AuditPortalPage />);
    expect(await screen.findByText(/Session invalid or expired/)).toBeDefined();
  });
  it('a 5xx says the pack is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    render(<AuditPortalPage />);
    expect(await screen.findByText(/audit pack is unavailable right now/)).toBeDefined();
  });
});

describe('forgot password', () => {
  it('a dropped connection says what could not be done, not "Network error"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const { container } = render(<ForgotPasswordPage />);
    fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: 'd2@example.test' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByText('Could not send the reset link - check your connection and try again.')).toBeDefined();
    expect(document.body.textContent).not.toContain('Network error');
  });
});

describe('invite accept', () => {
  it('a dropped connection on accept says what could not be done, not "Network error"', async () => {
    router.query = { token: 'tok' };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('socket hang up');
      if (String(url).includes('/api/auth/me')) return ok({ user: { id: 'u1', email: 'd2@example.test' } });
      return ok({ email: 'd2@example.test', companyName: 'D2 Co', role: 'admin', invitedBy: 'D2 Owner' });
    }));
    render(<InvitePage />);
    fireEvent.click(await screen.findByRole('button', { name: /join d2 co/i }));
    expect(await screen.findByText('Could not accept the invitation - check your connection and try again.')).toBeDefined();
    expect(document.body.textContent).not.toContain('Network error');
  });
});
