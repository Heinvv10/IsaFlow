import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { useReturnDeepLink } from '@/components/accounting/sars/useReturnDeepLink';

afterEach(cleanup);

function Probe({ setFrom, setTo, held }: { setFrom: (v: string) => void; setTo: (v: string) => void; held: { current: boolean } }) {
  useReturnDeepLink(setFrom, setTo, held);
  return null;
}
const within = (query: Record<string, string>, isReady = true) =>
  ({ isReady, query } as unknown as NextRouter);

describe('useReturnDeepLink', () => {
  it('sets the page period from ?from&to and holds it against the settings default', () => {
    const setFrom = vi.fn(); const setTo = vi.fn(); const held = { current: false };
    render(<RouterContext.Provider value={within({ from: '2026-09-01', to: '2026-10-31' })}><Probe setFrom={setFrom} setTo={setTo} held={held} /></RouterContext.Provider>);
    expect(setFrom).toHaveBeenCalledWith('2026-09-01');
    expect(setTo).toHaveBeenCalledWith('2026-10-31');
    expect(held.current).toBe(true);
  });
  it('ignores a bad link, an unready router, and a page with no router', () => {
    for (const router of [within({ from: 'x', to: '2026-10-31' }), within({ from: '2026-09-01', to: '2026-10-31' }, false), null]) {
      const setFrom = vi.fn(); const setTo = vi.fn(); const held = { current: false };
      render(<RouterContext.Provider value={router}><Probe setFrom={setFrom} setTo={setTo} held={held} /></RouterContext.Provider>);
      expect(setFrom).not.toHaveBeenCalled();
      expect(held.current).toBe(false);
      cleanup();
    }
  });
});
