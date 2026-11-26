// Admin sidebar on a phone: AdminLayout puts AdminNav in a flex row with <main>. The aside is w-56 (224px) and was
// always shown, so at 390px the page content got ~120px. The app shell already carries the same menu in the hamburger
// drawer (AppSidebar renders AdminDrawerNav on the admin host), so below lg the in-flow aside is hidden; at lg and up it
// stays. happy-dom applies no Tailwind CSS, so this asserts the class tokens.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/admin/billing', asPath: '/admin/billing', query: {} }) }));

import { AdminNav } from '@/components/admin/AdminNav';

afterEach(cleanup);

describe('AdminNav below lg', () => {
  it('hides the in-flow sidebar on phones and tablets', () => {
    render(<AdminNav />);
    expect(screen.getByRole('complementary').className.split(/\s+/)).toContain('max-lg:hidden');
  });

  it('keeps the desktop sidebar as it was (224px, no lg-only display override)', () => {
    render(<AdminNav />);
    const cls = screen.getByRole('complementary').className.split(/\s+/);
    expect(cls).toContain('w-56');
    expect(cls).toContain('flex');
    expect(cls.filter((c) => /^(hidden|lg:hidden|lg:flex|lg:block)$/.test(c))).toEqual([]);
  });
});
