/**
 * While the first session check runs, AppLayout renders ShellSkeleton instead of a full-screen spinner. Its bars
 * must be exactly as tall as the shell that replaces it, or the page jumps (layout shift) when the shell arrives.
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
    render(<ShellSkeleton navMode="top" collapsed={false} showTopNav hasModuleNav />);
    expect(height('shell-header')).toBe('56px');
    expect(height('shell-top-nav')).toBe('43px');
    expect(height('shell-module-nav')).toBe('44px');
    expect(SHELL_HEIGHTS).toEqual({ header: 56, topNav: 43, moduleNav: 44 });
  });

  it('reserves no module nav row on a page without one, and no top nav in sidebar mode', () => {
    render(<ShellSkeleton navMode="top" collapsed={false} showTopNav hasModuleNav={false} />);
    expect(screen.queryByTestId('shell-module-nav')).toBeNull();
    cleanup();
    render(<ShellSkeleton navMode="side" collapsed={false} showTopNav={false} hasModuleNav />);
    expect(screen.queryByTestId('shell-top-nav')).toBeNull();
    expect(screen.queryByTestId('shell-module-nav')).toBeNull();
  });

  it('marks the content area busy and shows the outage message inside it', () => {
    auth.authUnavailable = true;
    render(<ShellSkeleton navMode="top" collapsed={false} showTopNav hasModuleNav={false} />);
    const main = screen.getByRole('main');
    expect(main.getAttribute('aria-busy')).toBe('true');
    expect(main.contains(screen.getByRole('alert'))).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain("can't reach the sign-in service");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
