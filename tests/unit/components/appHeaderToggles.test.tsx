/**
 * The header bar no longer carries the row-density and theme toggles in the app: they moved into the Settings cog's
 * menu (settingsMenuDisplay.test.tsx), and below lg MobileHeaderMenu holds them. The admin host has no cog, so its
 * header keeps them inline from lg (below lg its MobileHeaderMenu has them).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { firstName: 'Q', lastName: 'A' }, logout: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'c1', name: 'QA Co' }, companies: [{ id: 'c1', name: 'QA Co' }], loading: false, switchCompany: vi.fn() }),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), pathname: '/accounting', asPath: '/accounting', query: {} }) }));
for (const m of ['CreateNewMenu', 'NotificationBell', 'MobileHeaderMenu']) {
  vi.doMock(`@/components/layout/${m}`, () => ({ [m]: () => null }));
}
vi.mock('@/components/layout/SettingsMenu', () => ({ SettingsMenu: () => <span data-testid="cog" /> }));
vi.mock('@/components/layout/ThemeToggle', () => ({ ThemeToggle: () => <span data-testid="theme-toggle" /> }));
vi.mock('@/components/ui/TableDensityToggle', () => ({ TableDensityToggle: () => <span data-testid="density-toggle" /> }));
vi.mock('@/components/onboarding/SetupGuideButton', () => ({ SetupGuideButton: () => null }));

afterEach(cleanup);

async function header(navMode: 'top' | 'side', isAdminHost: boolean) {
  const { AppHeader } = await import('@/components/layout/AppHeader');
  render(<AppHeader navMode={navMode} isAdminHost={isAdminHost} mobileNavOpen={false} onToggleMobileNav={vi.fn()} menuButtonRef={{ current: null }}
    onToggleNavMode={vi.fn()} onOpenCommandPalette={vi.fn()} />);
}

describe('AppHeader display toggles', () => {
  it.each(['top', 'side'] as const)('the app (%s nav): not in the header bar; the cog is there', async (mode) => {
    await header(mode, false);
    expect(screen.queryByTestId('theme-toggle')).toBeNull();
    expect(screen.queryByTestId('density-toggle')).toBeNull();
    expect(screen.getByTestId('cog')).toBeTruthy();
  });

  it('the admin host (no cog): both stay inline from lg', async () => {
    await header('top', true);
    expect(screen.queryByTestId('cog')).toBeNull();
    for (const id of ['theme-toggle', 'density-toggle']) {
      expect(screen.getByTestId(id).parentElement!.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:block']));
    }
  });
});
