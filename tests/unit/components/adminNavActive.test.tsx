import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let asPath = '/admin';
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: asPath.split('?')[0], asPath, query: {} }),
}));

import { AdminNav } from '@/components/admin/AdminNav';

afterEach(cleanup);

const isActive = (name: string) => screen.getByRole('link', { name }).className.includes('bg-brand-600');

describe('AdminNav active item', () => {
  it('lights Users on /admin/users and its sub-pages, query and fragment', () => {
    for (const p of ['/admin/users', '/admin/users/42', '/admin/users?q=a', '/admin/users#top']) {
      asPath = p;
      const { unmount } = render(<AdminNav />);
      expect(isActive('Users'), p).toBe(true);
      unmount();
    }
  });

  it('does not light Users for a sibling that shares the prefix', () => {
    asPath = '/admin/users-archive';
    render(<AdminNav />);
    expect(isActive('Users')).toBe(false);
  });
});

// Audit 4.10 / 4.16 (admin audit 2026-11-14).
const childActive = (name: string) => screen.getByRole('link', { name }).className.includes('bg-teal-600/80');

describe('AdminNav sections', () => {
  it.each([
    ['/admin/email-log', 'Tools', 'Email Log', 'Announcements'],
    ['/admin/webhooks', 'Tools', 'Webhooks', 'Sage Import'],
    ['/admin/web-analytics', 'Analytics', 'Web Traffic', 'Business'],
    ['/admin/web-analytics?range=30d', 'Analytics', 'Web Traffic', 'Business'],
  ])('on %s keeps %s open and lights %s', (path, parent, child, sibling) => {
    asPath = path;
    render(<AdminNav />);
    expect(screen.getByRole('link', { name: sibling }), 'section is open').toBeTruthy();
    expect(childActive(child)).toBe(true);
    expect(isActive(parent)).toBe(true);
    expect(childActive(sibling)).toBe(false);
  });

  it('lists PAYG Tenants and Flow Bundles under Billing and lights them on their pages', () => {
    asPath = '/admin/billing';
    const { unmount } = render(<AdminNav />);
    expect(screen.getByRole('link', { name: 'PAYG Tenants' }).getAttribute('href')).toBe('/admin/billing/payg');
    expect(screen.getByRole('link', { name: 'Flow Bundles' }).getAttribute('href')).toBe('/admin/billing/flow-bundles');
    expect(childActive('Overview')).toBe(true);
    unmount();
    for (const [p, name] of [['/admin/billing/payg', 'PAYG Tenants'], ['/admin/billing/flow-bundles', 'Flow Bundles']] as const) {
      asPath = p;
      const r = render(<AdminNav />);
      expect(childActive(name), p).toBe(true);
      expect(childActive('Overview'), `${p}: Overview stays dark`).toBe(false);
      expect(isActive('Billing'), p).toBe(true);
      r.unmount();
    }
  });

  it('a child page with a query string still lights its item', () => {
    asPath = '/admin/billing/subscriptions?companyId=c1';
    render(<AdminNav />);
    expect(childActive('Subscriptions')).toBe(true);
    expect(childActive('Overview')).toBe(false);
  });

  it('does not offer the developer Components showcase', () => {
    asPath = '/admin';
    render(<AdminNav />);
    expect(screen.queryByRole('link', { name: 'Components' })).toBeNull();
  });
});
