/**
 * D2 (admin pages, load-on-mount): the server's refusal message from the real error envelope
 * `{ success:false, error:{ code, message } }` reaches the user. The pages used to read `json.message`
 * (always undefined) and showed the generic fallback. Real apiJson/assertOk run over a scripted apiFetch.
 * NOT TESTED: pages/admin/email-log.tsx resend (the message is never rendered, only a "Failed" badge).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'u-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import BillingOverviewPage from '../../../pages/admin/billing/index';
import InvoicesPage from '../../../pages/admin/billing/invoices';
import PlansPage from '../../../pages/admin/billing/plans';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';
import FeaturesPage from '../../../pages/admin/features';
import HealthPage from '../../../pages/admin/health';
import AdminDashboard from '../../../pages/admin/index';
import SarsCodesPage from '../../../pages/admin/payroll/sars-codes';
import UsersPage from '../../../pages/admin/users/index';
import UserDetailPage from '../../../pages/admin/users/[id]';
import { UserAuditLog } from '@/components/admin/users/UserAuditLog';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refuse = (msg: string, status = 403) => json({ success: false, error: { code: 'FORBIDDEN', message: msg } }, status);
const ok = () => json({ success: true, data: {} });
const pathOf = (u: unknown) => String(u).split('?')[0];

/** Answer `failingPath` with the real error envelope, everything else with an empty success. */
function failOn(failingPath: string, msg: string, status?: number) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
    pathOf(url) === failingPath ? refuse(msg, status) : ok());
}

afterEach(() => { cleanup(); });

const CASES: Array<[string, () => JSX.Element, string]> = [
  ['billing overview (overview)', () => <BillingOverviewPage />, '/api/admin/billing/overview'],
  ['billing overview (subscriptions)', () => <BillingOverviewPage />, '/api/admin/billing/subscriptions'],
  ['billing invoices list', () => <InvoicesPage />, '/api/admin/billing/invoices'],
  ['billing plans list', () => <PlansPage />, '/api/admin/billing/plans'],
  ['billing subscriptions list', () => <SubscriptionsPage />, '/api/admin/billing/subscriptions'],
  ['feature flags list', () => <FeaturesPage />, '/api/admin/features'],
  ['system health', () => <HealthPage />, '/api/admin/health'],
  ['admin dashboard', () => <AdminDashboard />, '/api/admin/dashboard-stats'],
  ['SARS codes list', () => <SarsCodesPage />, '/api/admin/payroll/sars-codes'],
  ['users list', () => <UsersPage />, '/api/admin/users'],
  ['user detail', () => <UserDetailPage />, '/api/admin/users/u-1'],
  ['user audit log', () => <UserAuditLog userId="u-1" />, '/api/admin/audit'],
];

describe('load-on-mount admin screens show the server message', () => {
  it.each(CASES)('%s', async (name, ui, path) => {
    const msg = `D2 server says no: ${name}`;
    failOn(path, msg);
    render(ui());
    expect(await screen.findByText(new RegExp(msg.replace(/[()]/g, '\\$&')))).toBeTruthy();
  });
});
