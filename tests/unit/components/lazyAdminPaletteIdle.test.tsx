/**
 * #1373 re-review LOW: where the browser has requestIdleCallback, the admin palette chunk is requested from it,
 * after mount, not during the first render's work. (happy-dom has none, so this stubs it.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ requested: 0 }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminCommandPalette', () => {
  h.requested += 1;
  return { AdminCommandPalette: () => null };
});

import { LazyAdminCommandPalette } from '@/components/admin/LazyAdminCommandPalette';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LazyAdminCommandPalette preload', () => {
  it('waits for the idle callback, then requests the chunk', async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb));
    vi.stubGlobal('cancelIdleCallback', () => undefined);
    render(<LazyAdminCommandPalette isOpen={false} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    expect(h.requested).toBe(0);
    expect(idle.length).toBeGreaterThan(0);
    act(() => { for (const cb of idle) cb(); });
    await waitFor(() => expect(h.requested).toBe(1));
  });
});
