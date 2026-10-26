import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let asPath = '/admin';
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: asPath.split('?')[0], asPath, query: {} }),
}));

import { AdminNav } from '@/components/admin/AdminNav';

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
