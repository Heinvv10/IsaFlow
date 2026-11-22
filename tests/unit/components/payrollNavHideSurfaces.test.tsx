/**
 * The other places that offer a Payroll page: the Library grid tile and the "G then Y" shortcut. Both follow
 * `useNavFlags`, like the menus: gone without Payroll read, there with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ flags: new Set<string>() as ReadonlySet<string> }));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => h.flags }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), pathname: '/accounting/library', asPath: '/accounting/library', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => undefined }));

import LibraryPage from '../../../pages/accounting/library';
import { useGlobalShortcuts } from '@/components/layout/useGlobalShortcuts';
import { MODULE_READ_NAV_FLAGS } from '@/components/accounting/navSections/flagNav';

afterEach(() => { cleanup(); h.flags = new Set(); });

describe('Library grid', () => {
  it('has no Payroll tile without Payroll read, and keeps the other modules', () => {
    render(<LibraryPage />);
    expect(screen.queryByText('Employees, pay runs & leave')).toBeNull();
    expect(screen.getByText('Sales')).toBeTruthy();
  });
  it('shows the Payroll tile with Payroll read', () => {
    h.flags = new Set(MODULE_READ_NAV_FLAGS);
    render(<LibraryPage />);
    expect(screen.getByText('Employees, pay runs & leave')).toBeTruthy();
  });
});

describe('G then Y', () => {
  const go = () => renderHook(() => useGlobalShortcuts({ openCommandPalette: vi.fn(), openShortcutHelp: vi.fn() })).result.current
    .filter((s) => s.category === 'navigation').map((s) => s.description);
  it('is not offered without Payroll read', () => {
    expect(go()).not.toContain('Go to Payroll');
    expect(go()).toContain('Go to Sales');
  });
  it('is offered with Payroll read', () => {
    h.flags = new Set(MODULE_READ_NAV_FLAGS);
    expect(go()).toContain('Go to Payroll');
  });
});
