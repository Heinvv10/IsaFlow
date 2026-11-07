/**
 * NS2 (wave 4): the header's two icon-only buttons, the nav-mode toggle and Log out, carried only `title`, which
 * screen readers do not reliably announce (the probe on /accounting/bank-transactions found them as the page's 2
 * buttons with no aria-label and no text). Each gets its title as aria-label too, with the icon aria-hidden.
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

async function header(navMode: 'top' | 'side' = 'top') {
  const { AppHeader } = await import('@/components/layout/AppHeader');
  const ref = { current: null };
  render(<AppHeader navMode={navMode} isAdminHost={false} mobileNavOpen={false} onToggleMobileNav={vi.fn()} menuButtonRef={ref}
    onToggleNavMode={vi.fn()} onOpenCommandPalette={vi.fn()} />);
  return document.querySelector('header')!;
}

describe('AppHeader icon buttons have an aria-label, not only a title', () => {
  it.each([
    ['top', 'Switch to sidebar navigation'],
    ['side', 'Switch to top navigation'],
  ] as const)('nav-mode toggle (%s nav)', async (mode, name) => {
    await header(mode);
    const b = screen.getByTitle(name);
    expect(b).toHaveAttribute('aria-label', name);
    expect(b).toHaveAttribute('type', 'button');
    for (const svg of Array.from(b.querySelectorAll('svg'))) expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('Log out (top nav)', async () => {
    await header('top');
    const b = screen.getByTitle('Log out');
    expect(b).toHaveAttribute('aria-label', 'Log out');
    expect(b).toHaveAttribute('type', 'button');
    for (const svg of Array.from(b.querySelectorAll('svg'))) expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});
