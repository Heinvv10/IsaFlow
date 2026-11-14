/**
 * #1373 re-review LOW: the admin palette is its own chunk. It is fetched after mount, before anyone presses Ctrl+K,
 * and a Ctrl+K that beats it gets a focused search box whose text the real palette starts from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  return { requested: 0, gate, release: () => release() };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminCommandPalette', async () => {
  h.requested += 1;
  await h.gate;
  return {
    AdminCommandPalette: ({ isOpen, initialQuery }: { isOpen: boolean; initialQuery?: string }) =>
      (isOpen ? <div data-testid="real-palette" data-initial-query={initialQuery ?? ''} /> : null),
  };
});

import { LazyAdminCommandPalette } from '@/components/admin/LazyAdminCommandPalette';

afterEach(cleanup);

describe('LazyAdminCommandPalette', () => {
  it('requests the chunk after mount while still closed, and keystrokes typed before it lands carry over', async () => {
    const { rerender } = render(<LazyAdminCommandPalette isOpen={false} onClose={() => undefined} />);
    await waitFor(() => expect(h.requested).toBe(1));
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<LazyAdminCommandPalette isOpen onClose={() => undefined} />);
    const box = screen.getByRole('textbox', { name: 'Search admin pages, companies and users' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.change(box, { target: { value: 'acme' } });
    expect(screen.getByRole('status').textContent).toBe('Loading…');

    await act(async () => { h.release(); await h.gate; });
    const real = await screen.findByTestId('real-palette');
    expect(real.getAttribute('data-initial-query')).toBe('acme');
    expect(h.requested).toBe(1);
  });
});
