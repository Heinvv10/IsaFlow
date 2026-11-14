// Admin audit 4.14: every admin page has its own browser-tab title and exactly one <h1>. Before, every tab read
// "IsaFlow" and ten pages printed their title twice (the layout's <h1> plus the page's own header).
// Each page renders with every API call failing, so this pins the page chrome, not its data.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/lib/apiFetch', async () => {
  const real = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  const failed = async () => new Response(JSON.stringify({ success: false, error: { message: 'offline in this test' } }), { status: 500 });
  return { ...real, apiFetch: vi.fn(failed) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/head', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(async () => true), pathname: '/admin', asPath: '/admin', isReady: true, events: { on: vi.fn(), off: vi.fn() } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1', role: 'super_admin', email: 'a@b.test' }, loading: false }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminNav', () => ({ AdminNav: () => <nav /> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p, useAdminPrefix: () => '' }));
vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));

const PAGES: [string, () => Promise<{ default: () => JSX.Element }>][] = [
  ['Admin Dashboard', () => import('../../../pages/admin/index')],
  ['Companies', () => import('../../../pages/admin/companies/index')],
  ['Users', () => import('../../../pages/admin/users/index')],
  ['Billing Plans', () => import('../../../pages/admin/billing/plans')],
  ['Flow Bundles', () => import('../../../pages/admin/billing/flow-bundles')],
  ['Feature Flags', () => import('../../../pages/admin/features')],
  ['Audit Trail', () => import('../../../pages/admin/audit')],
  ['Platform Settings', () => import('../../../pages/admin/settings')],
  ['Component Library', () => import('../../../pages/admin/components')],
  ['Email Delivery Log', () => import('../../../pages/admin/email-log')],
  ['System Health', () => import('../../../pages/admin/health')],
  ['Background Jobs', () => import('../../../pages/admin/job-queue')],
  ['SARS Source Codes', () => import('../../../pages/admin/payroll/sars-codes')],
  ['Announcements', () => import('../../../pages/admin/tools/announcements')],
  ['Admin Tools', () => import('../../../pages/admin/tools/index')],
  ['Data Migration', () => import('../../../pages/admin/tools/migrations')],
  ['Sage Auto-Import', () => import('../../../pages/admin/tools/sage-import')],
  ['Webhook Management', () => import('../../../pages/admin/webhooks')],
];

afterEach(() => { cleanup(); });

describe('admin page chrome', () => {
  it.each(PAGES)('%s: one <h1> and its own tab title', async (title, load) => {
    const { default: Page } = await load();
    render(<Page />);
    await waitFor(() => expect(document.querySelector('title')?.textContent).toBe(`${title} · Admin · IsaFlow`));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  }, 20_000);
});
