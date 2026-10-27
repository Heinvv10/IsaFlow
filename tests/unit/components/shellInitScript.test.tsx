/**
 * public/shell-init.js (runs before first paint) and shellPrefs.ts (AppLayout) must agree on the storage keys, the
 * attribute values and the admin host, or the skeleton and the shell draw different layouts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { ADMIN_HOST, NAV_MODE_KEY, SIDEBAR_COLLAPSED_KEY, readShellPrefs, writeShellPrefs } from '@/components/layout/shellPrefs';

const script = readFileSync('public/shell-init.js', 'utf8');
const run = () => new Function(script)();

afterEach(() => {
  localStorage.clear();
  for (const a of ['data-nav-mode', 'data-sidebar-collapsed', 'data-admin-host']) document.documentElement.removeAttribute(a);
});

describe('shell-init.js and shellPrefs', () => {
  it('names the same storage keys and admin host', () => {
    expect(script).toContain(`'${NAV_MODE_KEY}'`);
    expect(script).toContain(`'${SIDEBAR_COLLAPSED_KEY}'`);
    expect(script).toContain(`'${ADMIN_HOST}'`);
  });

  it('what AppLayout saves, the script turns into the attributes AppLayout reads back', () => {
    writeShellPrefs('side', true);
    for (const a of ['data-nav-mode', 'data-sidebar-collapsed']) document.documentElement.removeAttribute(a);
    run();
    expect(readShellPrefs()).toEqual({ navMode: 'side', collapsed: true, isAdminHost: false });
  });

  it('defaults to the top nav when nothing is saved', () => {
    run();
    expect(readShellPrefs()).toEqual({ navMode: 'top', collapsed: false, isAdminHost: false });
  });

  it('writeShellPrefs mirrors a switch back to the top nav onto <html> at once', () => {
    writeShellPrefs('side', false);
    writeShellPrefs('top', false);
    expect(document.documentElement.hasAttribute('data-nav-mode')).toBe(false);
    expect(localStorage.getItem(NAV_MODE_KEY)).toBe('top');
  });

  it('writeShellPrefs still applies the layout when storage refuses the write', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      expect(() => writeShellPrefs('side', false)).not.toThrow();
      expect(readShellPrefs().navMode).toBe('side');
    } finally {
      spy.mockRestore();
    }
  });
});
