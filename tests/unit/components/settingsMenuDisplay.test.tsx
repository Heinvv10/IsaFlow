/**
 * The row-density and theme toggles are set-once controls: where the header bar used to show them inline (from lg, from
 * xl in sidebar mode) they now live in the Settings cog's popover, in a Display group. Same components
 * (TableDensityToggle, ThemeToggle), labelled, reachable from the keyboard and working. Below that breakpoint
 * MobileHeaderMenu carries them, so the cog hides its Display group there (`displayClassName`): one place per width.
 *
 * Role tree: group "Settings" (the popover) > [group "Display" > group "Colour theme", group "Table row density"] and
 * [menu "Settings" > menuitem…]. The aria-pressed toggles are not inside the menu, which may only own menuitems.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {}, push: vi.fn() }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ preference: 'dark', ready: true, setPreference: h.setPreference }) }));

import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { TableDensityProvider } from '@/contexts/TableDensityContext';

beforeEach(() => { localStorage.clear(); h.setPreference.mockClear(); });
afterEach(() => { cleanup(); delete document.documentElement.dataset.density; document.getElementById('below-lg')?.remove(); });

const cog = () => screen.getByRole('button', { name: 'Settings' });
const openCog = (keyboard = false) => {
  render(<TableDensityProvider><SettingsMenu displayClassName="hidden lg:block" /></TableDensityProvider>);
  fireEvent.click(cog(), { detail: keyboard ? 0 : 1 });
  return screen.getByRole('group', { name: 'Settings' });
};
const displayOf = (panel: HTMLElement) => within(panel).getByRole('group', { name: 'Display' });
/** Tailwind is not compiled here: this is what `hidden` (without its lg:block) does below lg. */
const belowLg = () => {
  const style = document.createElement('style');
  style.id = 'below-lg';
  style.textContent = '.hidden{display:none}';
  document.head.appendChild(style);
};

describe('Settings cog: display toggles', () => {
  it('holds a labelled Display group with the row-density and theme toggles, above the pages', () => {
    const panel = openCog();
    const display = displayOf(panel);
    expect(within(display).getByText('Row density')).toBeTruthy();
    expect(within(display).getByText('Theme')).toBeTruthy();
    expect(within(display).getByRole('group', { name: 'Table row density' })).toBeTruthy();
    expect(within(display).getByRole('group', { name: 'Colour theme' })).toBeTruthy();
    // Above the pages: the popover scrolls inside itself on a short screen, and the toggles must not hide below its fold.
    const firstPage = within(panel).getAllByRole('menuitem')[0]!;
    expect(display.compareDocumentPosition(firstPage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the Display group only from the breakpoint it is given (below it MobileHeaderMenu has the toggles)', () => {
    expect(displayOf(openCog()).className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:block']));
  });

  it('the menu owns menuitems only: the toggles sit beside it in the popover, not inside it', () => {
    const panel = openCog();
    const menu = within(panel).getByRole('menu', { name: 'Settings' });
    expect(menu.contains(displayOf(panel))).toBe(false);
    expect(displayOf(panel).closest('[role="menu"]')).toBeNull();
    expect(panel.closest('[role="menu"]')).toBeNull();
    expect(menu.querySelectorAll('button:not([role="menuitem"]), [aria-pressed], a').length).toBe(0);
    expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThan(10);
    // The lists that lay the pages out are presentational: a menu may not own list items.
    expect(menu.querySelectorAll('ul:not([role="none"]), li:not([role="none"])').length).toBe(0);
  });

  it('the toggles still work: Compact sets the root density, Light sets the theme preference', async () => {
    const display = displayOf(openCog());
    await act(async () => { fireEvent.click(within(display).getByRole('button', { name: /^Compact/ })); });
    expect(document.documentElement.dataset.density).toBe('compact');
    fireEvent.click(within(display).getByRole('button', { name: 'Light' }));
    expect(h.setPreference).toHaveBeenCalledWith('light');
    // Choosing a setting does not close the popover.
    expect(screen.getByRole('group', { name: 'Settings' })).toBeTruthy();
  });

  it('opened from the keyboard, focus lands on the first Display control and Tab runs top to bottom: toggles, then pages', () => {
    const panel = openCog(true);
    const toggles = within(displayOf(panel)).getAllByRole('button');
    expect(toggles.map((b) => b.getAttribute('aria-label'))).toEqual(['Light', 'Dark', 'System', 'Comfortable — standard row height', 'Compact — reduced row height']);
    expect(document.activeElement).toBe(toggles[0]);
    // Tab order is DOM order (no positive tabindex): the five toggles, then the first page.
    const tabbable = [...panel.querySelectorAll<HTMLElement>('button')].filter((b) => b.tabIndex >= 0);
    expect(tabbable.slice(0, 6)).toEqual([...toggles, within(panel).getAllByRole('menuitem')[0]]);
    expect(panel.querySelector('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toBeNull();
  });

  it('opened from the keyboard where the Display group is hidden, focus lands on the first page', () => {
    belowLg();
    const panel = openCog(true);
    expect(document.activeElement).toBe(within(panel).getAllByRole('menuitem')[0]);
  });

  it('Escape closes it and puts focus back on the cog', () => {
    openCog(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Settings' })).toBeNull();
    expect(document.activeElement).toBe(cog());
  });
});
