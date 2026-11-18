/**
 * The row-density and theme toggles are set-once controls: from lg up they live in the Settings cog's menu, not in the
 * header bar. Same components (TableDensityToggle, ThemeToggle), labelled, reachable from the keyboard and working.
 * The admin host has no cog, so there the header keeps them inline; below lg MobileHeaderMenu still carries them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {}, push: vi.fn() }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ preference: 'dark', ready: true, setPreference: h.setPreference }) }));

import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { TableDensityProvider } from '@/contexts/TableDensityContext';

beforeEach(() => { localStorage.clear(); h.setPreference.mockClear(); });
afterEach(() => { cleanup(); delete document.documentElement.dataset.density; });

const openCog = (keyboard = false) => {
  render(<TableDensityProvider><SettingsMenu /></TableDensityProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }), { detail: keyboard ? 0 : 1 });
  return screen.getByRole('menu', { name: 'Settings' });
};

describe('Settings cog: display toggles', () => {
  it('holds a labelled Display group with the row-density and theme toggles', () => {
    const menu = openCog();
    const display = within(menu).getByRole('group', { name: 'Display' });
    expect(within(display).getByText('Row density')).toBeTruthy();
    expect(within(display).getByText('Theme')).toBeTruthy();
    expect(within(display).getByRole('group', { name: 'Table row density' })).toBeTruthy();
    expect(within(display).getByRole('group', { name: 'Colour theme' })).toBeTruthy();
    // Above the pages: the menu scrolls inside itself on a short screen, and the toggles must not hide below its fold.
    const firstPage = within(menu).getAllByRole('menuitem')[0]!;
    expect(display.compareDocumentPosition(firstPage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the toggles still work: Compact sets the root density, Light sets the theme preference', async () => {
    const display = within(openCog()).getByRole('group', { name: 'Display' });
    await act(async () => { fireEvent.click(within(display).getByRole('button', { name: /^Compact/ })); });
    expect(document.documentElement.dataset.density).toBe('compact');
    fireEvent.click(within(display).getByRole('button', { name: 'Light' }));
    expect(h.setPreference).toHaveBeenCalledWith('light');
    // Choosing a setting does not close the menu.
    expect(screen.getByRole('menu', { name: 'Settings' })).toBeTruthy();
  });

  it('opened from the keyboard, focus moves into the menu, and every toggle button is in the tab order', () => {
    const menu = openCog(true);
    expect(menu.contains(document.activeElement)).toBe(true);
    const buttons = within(within(menu).getByRole('group', { name: 'Display' })).getAllByRole('button');
    expect(buttons).toHaveLength(5);
    for (const b of buttons) expect(b.tabIndex).toBe(0);
  });
});
