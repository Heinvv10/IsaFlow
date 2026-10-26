/**
 * While the first session check runs, AppLayout renders ShellSkeleton instead of a full-screen spinner. Its bars
 * must be exactly as tall as the shell that replaces it, or the page jumps (layout shift) when the shell arrives.
 * (The golden spec s-shell-cls-mobile checks the real bars against the same SHELL_HEIGHTS.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const auth = vi.hoisted(() => ({ authUnavailable: false, authChecking: false, refreshUser: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('next/image', () => ({ default: () => null }));

import { ShellSkeleton } from '@/components/layout/ShellSkeleton';
import { SHELL_HEIGHTS } from '@/components/layout/shellHeights';

afterEach(() => { cleanup(); auth.authUnavailable = false; });

const height = (id: string) => screen.getByTestId(id).style.height;

describe('ShellSkeleton', () => {
  it('reserves the header, the top nav and the module nav at the shell heights', () => {
    render(<ShellSkeleton hasModuleNav />);
    expect(height('shell-header')).toBe(`${SHELL_HEIGHTS.header}px`);
    expect(height('shell-top-nav')).toBe(`${SHELL_HEIGHTS.topNav}px`);
    expect(height('shell-module-nav')).toBe(`${SHELL_HEIGHTS.moduleNav}px`);
  });

  it('reserves no module nav row on a page without one', () => {
    render(<ShellSkeleton hasModuleNav={false} />);
    expect(screen.queryByTestId('shell-module-nav')).toBeNull();
  });

  it('marks the sidebar and the top rows for the nav-mode CSS (globals.css), not React state', () => {
    render(<ShellSkeleton hasModuleNav />);
    expect(screen.getByTestId('shell-side').hasAttribute('data-shell-side')).toBe(true);
    expect(screen.getByTestId('shell-top-nav').hasAttribute('data-shell-top-nav')).toBe(true);
    expect(screen.getByTestId('shell-module-nav').hasAttribute('data-shell-top-nav')).toBe(true);
  });

  it('shows a page-shaped placeholder in the busy content area, not a spinner', () => {
    render(<ShellSkeleton hasModuleNav={false} />);
    const main = screen.getByRole('main');
    expect(main.getAttribute('aria-busy')).toBe('true');
    expect(main.querySelector('.animate-pulse')).not.toBeNull();
    expect(main.querySelector('.animate-spin')).toBeNull();
  });

  it('shows the outage message inside the content area', () => {
    auth.authUnavailable = true;
    render(<ShellSkeleton hasModuleNav={false} />);
    const main = screen.getByRole('main');
    expect(main.contains(screen.getByRole('alert'))).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain("can't reach the sign-in service");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
