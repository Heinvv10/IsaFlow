/**
 * App audit P2.5 item 14: the install banner shows on the dashboard only, once, on one line, with an AA button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { act, cleanup, render, screen } from '@testing-library/react';
import tw from 'tailwindcss/colors';
import { PwaInstallBanner, usePwaInstallPrompt } from '@/components/layout/PwaInstallBanner';
import { contrastRatio } from '@/lib/brand/contrast';

const KEY = 'isaflow-pwa-install-dismissed';

function Harness({ enabled }: { enabled: boolean }) {
  const p = usePwaInstallPrompt(enabled);
  return <PwaInstallBanner {...p} />;
}

/** Hook only, no banner drawn: what AppLayout has during the session check. */
function Undrawn() {
  usePwaInstallPrompt(true);
  return null;
}

const offer = () => {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  act(() => { window.dispatchEvent(e); });
  return e;
};
const banner = () => screen.queryByRole('region', { name: 'Install IsaFlow' });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('PWA install banner', () => {
  it('shows when the browser offers an install and marks itself seen once drawn', () => {
    render(<Harness enabled />);
    offer();
    expect(banner()?.textContent).toContain('Install IsaFlow on this device');
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('never shows a second time, yet still suppresses the browser prompt on later loads', () => {
    const first = render(<Harness enabled />);
    offer();
    first.unmount();
    render(<Harness enabled />);
    const e = offer();
    expect(banner()).toBeNull();
    expect(e.defaultPrevented).toBe(true);
  });

  it('still suppresses the browser prompt after a dismiss', () => {
    localStorage.setItem(KEY, '1');
    render(<Harness enabled />);
    expect(offer().defaultPrevented).toBe(true);
    expect(banner()).toBeNull();
  });

  it('shows nothing and stores nothing off the dashboard, but still suppresses the browser prompt there', () => {
    render(<Harness enabled={false} />);
    const e = offer();
    expect(e.defaultPrevented).toBe(true);
    expect(banner()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('is not marked seen when the offer arrives but the banner is never drawn', () => {
    render(<Undrawn />);
    offer();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('an offer made off the dashboard shows once the user reaches the dashboard', () => {
    const { rerender } = render(<Harness enabled={false} />);
    offer();
    rerender(<Harness enabled />);
    expect(banner()).not.toBeNull();
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('leaving the dashboard ends it: it does not come back on the next dashboard render', () => {
    const { rerender } = render(<Harness enabled />);
    offer();
    rerender(<Harness enabled={false} />);
    expect(banner()).toBeNull();
    rerender(<Harness enabled />);
    expect(banner()).toBeNull();
  });

  it('has an AA Install button: solid white with dark brand text, not white on 20% white', () => {
    render(<Harness enabled />);
    offer();
    const cls = screen.getByRole('button', { name: 'Install' }).className.split(/\s+/);
    expect(cls).toContain('bg-white');
    expect(cls).toContain('text-brand-800');
    expect(cls).not.toContain('bg-white/20');
    expect(screen.getByRole('button', { name: 'Dismiss install prompt' })).toBeTruthy();
  });

  it('the Install button colours measure AA: brand-800 text on white and on its teal-50 hover', () => {
    const css = readFileSync(join(process.cwd(), 'styles/globals.css'), 'utf8');
    const values = [...css.matchAll(/--ff-brand-800-rgb:\s*(\d+)\s+(\d+)\s+(\d+)/g)];
    expect(values.length).toBeGreaterThan(0); // every theme block that sets it is measured
    for (const m of values) {
      const hex = '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      expect(contrastRatio(hex, '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, tw.teal[50])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('still hides itself after 10 seconds', () => {
    vi.useFakeTimers();
    render(<Harness enabled />);
    offer();
    expect(banner()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(banner()).toBeNull();
  });
});
