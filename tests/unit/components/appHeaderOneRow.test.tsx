/**
 * The header stays one row at 390 / 768 / 1024 / 1280 px with the notifications bell (PR #1066
 * browser measurement): below lg the search is an icon (the 152px pill only from lg), below sm the
 * gaps are 8px and the company switcher's padding/gap tighter. Recovered at 390 vs master: 8 gaps x
 * 4px + 8px padding + 4px inner gap = 44px, the bell's 32px + one gap. happy-dom has no layout, so
 * this pins the classes; the pixel check is the browser measurement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { firstName: 'Q', lastName: 'A' }, logout: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'c1', name: 'QA Co' }, companies: [{ id: 'c1', name: 'QA Co' }], loading: false, switchCompany: vi.fn() }),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), pathname: '/accounting', asPath: '/accounting', query: {} }) }));
for (const m of ['CreateNewMenu', 'SettingsMenu', 'ThemeToggle', 'NotificationBell', 'MobileHeaderMenu']) {
  vi.doMock(`@/components/layout/${m}`, () => ({ [m]: () => null }));
}
vi.mock('@/components/ui/TableDensityToggle', () => ({ TableDensityToggle: () => null }));
vi.mock('@/components/onboarding/SetupGuideButton', () => ({ SetupGuideButton: () => null }));

afterEach(cleanup);

async function header() {
  const { AppHeader } = await import('@/components/layout/AppHeader');
  const ref = { current: null };
  render(<AppHeader navMode="top" isAdminHost={false} mobileNavOpen={false} onToggleMobileNav={vi.fn()} menuButtonRef={ref}
    onToggleNavMode={vi.fn()} onOpenCommandPalette={vi.fn()} />);
  return document.querySelector('header')!;
}

describe('AppHeader fits one row with the bell', () => {
  it('search: the pill only from lg, the icon below lg', async () => {
    await header();
    expect(screen.getByTitle('Search (Ctrl+K)').className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:flex']));
    expect(screen.getByRole('button', { name: 'Open search' }).className.split(/\s+/)).toContain('lg:hidden');
  });

  it('gaps are 8px below sm, 12px from sm', async () => {
    const h = await header();
    expect(h.className.split(/\s+/)).toEqual(expect.arrayContaining(['gap-x-2', 'sm:gap-x-3']));
    expect(h.className.split(/\s+/)).not.toContain('gap-x-3');
  });

  it('the company switcher is tighter below sm and keeps its accessible name', async () => {
    await header();
    const sw = screen.getByRole('button', { name: /Switch company/ });
    expect(sw.className.split(/\s+/)).toEqual(expect.arrayContaining(['px-2', 'sm:px-3', 'gap-1', 'sm:gap-2']));
  });
});
