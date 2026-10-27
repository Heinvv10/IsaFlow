/**
 * The saved shell layout (nav mode, collapsed sidebar) and the admin-host check, shared by AppLayout and
 * public/shell-init.js. The script copies them onto <html> before first paint; AppLayout seeds its state from those
 * attributes, so even a fresh AppLayout (every client-side navigation mounts one) draws the right nav on its first
 * frame, and writes them back when the user changes them. tests/unit/components/shellInitScript.test.tsx holds the script
 * and these constants together.
 */
import { log } from '@/lib/logger';

export const NAV_MODE_KEY = 'accounting-nav-mode';
export const SIDEBAR_COLLAPSED_KEY = 'accounting-sidebar-collapsed';
export const ADMIN_HOST = 'admin.isaflow.co.za';

export type NavMode = 'top' | 'side';

export interface ShellPrefs { navMode: NavMode; collapsed: boolean; isAdminHost: boolean }

/** From the <html> attributes shell-init.js set; the defaults on the server, where there is no document. */
export function readShellPrefs(): ShellPrefs {
  if (typeof document === 'undefined') return { navMode: 'top', collapsed: false, isAdminHost: false };
  const root = document.documentElement;
  return {
    navMode: root.getAttribute('data-nav-mode') === 'side' ? 'side' : 'top',
    collapsed: root.getAttribute('data-sidebar-collapsed') === 'true',
    isAdminHost: root.hasAttribute('data-admin-host'),
  };
}

/** Saves the user's choice and mirrors it onto <html>, so the next AppLayout and the next page load start from it. */
export function writeShellPrefs(navMode: NavMode, collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_MODE_KEY, navMode);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
  } catch (err) {
    // Storage blocked or full: the choice still applies to this page (the attributes below), it just isn't saved.
    log.warn('Could not save the shell layout preference', { error: err }, 'shellPrefs');
  }
  const root = document.documentElement;
  if (navMode === 'side') root.setAttribute('data-nav-mode', 'side');
  else root.removeAttribute('data-nav-mode');
  if (collapsed) root.setAttribute('data-sidebar-collapsed', 'true');
  else root.removeAttribute('data-sidebar-collapsed');
}
