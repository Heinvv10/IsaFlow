/**
 * Theme preference (master plan §3b.1): Light / Dark / System, stored in localStorage
 * 'accounting-theme'. System follows prefers-color-scheme live; every theme sets the root
 * `dark` class AND `color-scheme`, so native select/date pop-ups render in the theme.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { ThemeToggle } from '@/components/layout/ThemeToggle';

const STORAGE_KEY = 'accounting-theme';

interface MockMql {
  matches: boolean;
  listeners: Set<(e: { matches: boolean }) => void>;
}
let mql: MockMql;

function mockMatchMedia(matches: boolean): void {
  mql = { matches, listeners: new Set() };
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() { return mql.matches; },
    media: query,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => mql.listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => mql.listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
}
function osSwitchesTo(dark: boolean): void {
  mql.matches = dark;
  act(() => { mql.listeners.forEach((fn) => fn({ matches: dark })); });
}

const root = () => document.documentElement;
const scheme = () => root().style.getPropertyValue('color-scheme');

function Probe() {
  const { theme, preference } = useTheme();
  return <p data-testid="probe">{preference}:{theme}</p>;
}

beforeEach(() => {
  window.localStorage.clear();
  root().classList.remove('dark');
  root().style.removeProperty('color-scheme');
  mockMatchMedia(false);
});
afterEach(cleanup);

describe('ThemeProvider', () => {
  it('keeps a saved light preference through a StrictMode mount (it used to be overwritten with dark)', () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    render(<StrictMode><ThemeProvider><Probe /></ThemeProvider></StrictMode>);
    expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(root().classList.contains('dark')).toBe(false);
    expect(scheme()).toBe('light');
  });

  it('defaults to dark when nothing is saved, and does not write a preference nobody chose', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
    expect(root().classList.contains('dark')).toBe(true);
    expect(scheme()).toBe('dark');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('system mode follows the OS and tracks a live prefers-color-scheme change', () => {
    window.localStorage.setItem(STORAGE_KEY, 'system');
    mockMatchMedia(true);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('probe')).toHaveTextContent('system:dark');
    expect(root().classList.contains('dark')).toBe(true);
    expect(scheme()).toBe('dark');

    osSwitchesTo(false);
    expect(screen.getByTestId('probe')).toHaveTextContent('system:light');
    expect(root().classList.contains('dark')).toBe(false);
    expect(scheme()).toBe('light');

    osSwitchesTo(true);
    expect(screen.getByTestId('probe')).toHaveTextContent('system:dark');
    expect(scheme()).toBe('dark');
  });

  it('an explicit preference ignores an OS change', () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    mockMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    osSwitchesTo(true);
    expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
    expect(scheme()).toBe('light');
  });

  it('setPreference persists the choice and applies it', () => {
    function Buttons() {
      const { setPreference } = useTheme();
      return <button onClick={() => setPreference('light')}>go light</button>;
    }
    render(<ThemeProvider><Probe /><Buttons /></ThemeProvider>);
    fireEvent.click(screen.getByText('go light'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(root().classList.contains('dark')).toBe(false);
    expect(scheme()).toBe('light');
  });

  it('toggleTheme flips the resolved theme into an explicit preference', () => {
    window.localStorage.setItem(STORAGE_KEY, 'system');
    mockMatchMedia(true);
    function Flip() {
      const { toggleTheme } = useTheme();
      return <button onClick={toggleTheme}>flip</button>;
    }
    render(<ThemeProvider><Probe /><Flip /></ThemeProvider>);
    fireEvent.click(screen.getByText('flip'));
    expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('ignores a stored value that is not a preference', () => {
    window.localStorage.setItem(STORAGE_KEY, 'solarized');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
  });
});

describe('ThemeToggle', () => {
  it('offers Light, Dark and System, marks the saved one, and switches on click', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    render(<ThemeProvider><ThemeToggle /><Probe /></ThemeProvider>);
    const group = screen.getByRole('group', { name: 'Colour theme' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('system');
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('public/theme-init.js (runs before first paint)', () => {
  const script = readFileSync(join(process.cwd(), 'public/theme-init.js'), 'utf8');
  const run = () => new Function(script)();

  it('applies a saved light preference', () => {
    root().classList.add('dark');
    window.localStorage.setItem(STORAGE_KEY, 'light');
    run();
    expect(root().classList.contains('dark')).toBe(false);
    expect(scheme()).toBe('light');
  });

  it('resolves system against the OS', () => {
    window.localStorage.setItem(STORAGE_KEY, 'system');
    mockMatchMedia(true);
    run();
    expect(root().classList.contains('dark')).toBe(true);
    expect(scheme()).toBe('dark');
  });

  it('resolves system to light when the OS is light', () => {
    window.localStorage.setItem(STORAGE_KEY, 'system');
    mockMatchMedia(false);
    run();
    expect(root().classList.contains('dark')).toBe(false);
    expect(scheme()).toBe('light');
  });

  it('defaults to dark with nothing saved', () => {
    run();
    expect(root().classList.contains('dark')).toBe(true);
    expect(scheme()).toBe('dark');
  });
});
