/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * THE OBJECT URL OUTLIVES THE CLICK. The hook revoked it synchronously after
 * `a.click()` on an anchor that was never in the document, which cancels the
 * download in browsers that start it asynchronously. The anchor is attached
 * for the click and the URL is revoked on a later tick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/apiFetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  return { ...actual, apiFetch: (...a: unknown[]) => apiFetchMock(...a) };
});
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { usePackDownload } from '@/components/accounting/packs/usePackDownload';

let connectedAtClick: boolean | null;
let anchor: HTMLAnchorElement | null;
let revoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  connectedAtClick = null;
  anchor = null;
  revoke = vi.fn();
  apiFetchMock.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:pack');
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createElement(tag);
    if (tag === 'a') {
      anchor = el as HTMLAnchorElement;
      el.click = () => { connectedAtClick = el.isConnected; };
    }
    return el;
  });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanup(); });

describe('usePackDownload — when the object URL is released', () => {
  it('clicks an attached anchor, removes it, and revokes only on a later tick', async () => {
    vi.useFakeTimers();
    apiFetchMock.mockResolvedValue(new Response('%PDF-1.7 fake', { status: 200 }));
    const { result } = renderHook(() => usePackDownload({ packType: 'board', from: '2026-01-01', to: '2026-08-31' }));
    await act(async () => { await result.current.download('pdf'); });

    expect(connectedAtClick).toBe(true);
    expect(anchor?.isConnected).toBe(false);
    expect(revoke).not.toHaveBeenCalled();

    await act(async () => { await vi.runAllTimersAsync(); });
    expect(revoke).toHaveBeenCalledWith('blob:pack');
  });
});
