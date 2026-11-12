/**
 * App audit P2.5 item 14: the install banner shows on the dashboard only, once, on one line, with an AA button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PwaInstallBanner, usePwaInstallPrompt } from '@/components/layout/PwaInstallBanner';

const KEY = 'isaflow-pwa-install-dismissed';

function Harness({ enabled }: { enabled: boolean }) {
  const p = usePwaInstallPrompt(enabled);
  return <PwaInstallBanner {...p} />;
}

const offer = () => act(() => { window.dispatchEvent(new Event('beforeinstallprompt')); });
const banner = () => screen.queryByRole('region', { name: 'Install IsaFlow' });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('PWA install banner', () => {
  it('shows when the browser offers an install and marks itself seen at once', () => {
    render(<Harness enabled />);
    offer();
    expect(banner()?.textContent).toContain('Install IsaFlow on this device');
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('never shows a second time', () => {
    const first = render(<Harness enabled />);
    offer();
    first.unmount();
    render(<Harness enabled />);
    offer();
    expect(banner()).toBeNull();
  });

  it('shows nothing and stores nothing off the dashboard', () => {
    render(<Harness enabled={false} />);
    offer();
    expect(banner()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
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

  it('still hides itself after 10 seconds', () => {
    vi.useFakeTimers();
    render(<Harness enabled />);
    offer();
    expect(banner()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(banner()).toBeNull();
  });
});
