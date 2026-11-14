/**
 * #1373 re-review LOWs, while the admin palette's chunk has not landed (it never does here):
 * Ctrl+K before the idle preload requests it at once; text typed in the loading shell does not survive a close.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ requested: 0 }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminCommandPalette', async () => {
  h.requested += 1;
  await new Promise<never>(() => undefined);
  return {};
});

import { LazyAdminCommandPalette } from '@/components/admin/LazyAdminCommandPalette';

// The idle callback never fires: only opening the palette can request the chunk.
beforeAll(() => {
  vi.stubGlobal('requestIdleCallback', () => 1);
  vi.stubGlobal('cancelIdleCallback', () => undefined);
});
afterAll(() => { vi.unstubAllGlobals(); });
afterEach(cleanup);

const box = () => screen.getByRole('textbox', { name: 'Search admin pages, companies and users' }) as HTMLInputElement;

describe('LazyAdminCommandPalette before its chunk lands', () => {
  it('Ctrl+K before the idle preload requests the chunk at once', async () => {
    const { rerender } = render(<LazyAdminCommandPalette isOpen={false} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    expect(h.requested).toBe(0);
    rerender(<LazyAdminCommandPalette isOpen onClose={() => undefined} />);
    await waitFor(() => expect(h.requested).toBe(1));
    expect(box()).toBeTruthy();
  });

  it('open, type, close, reopen: the box starts empty', () => {
    const { rerender } = render(<LazyAdminCommandPalette isOpen onClose={() => undefined} />);
    fireEvent.change(box(), { target: { value: 'acme' } });
    expect(box().value).toBe('acme');
    rerender(<LazyAdminCommandPalette isOpen={false} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<LazyAdminCommandPalette isOpen onClose={() => undefined} />);
    expect(box().value).toBe('');
  });
});
