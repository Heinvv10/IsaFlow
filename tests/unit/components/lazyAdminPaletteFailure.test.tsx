/**
 * #1373 re-review LOWs: when the admin palette's chunk cannot load (a deploy replaced it, the network dropped),
 * Ctrl+K says so and logs it instead of opening nothing; focus moves into the dialog; the next open tries again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ warn: vi.fn(), attempts: 0 }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: h.warn, debug: vi.fn() } }));
// The first load fails like a dropped chunk; a retry succeeds.
vi.mock('@/components/admin/AdminCommandPalette', () => {
  h.attempts += 1;
  if (h.attempts === 1) throw new Error('ChunkLoadError: Loading chunk 4711 failed.');
  return { AdminCommandPalette: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="real-palette" /> : null) };
});

import { LazyAdminCommandPalette, SEARCH_UNAVAILABLE } from '@/components/admin/LazyAdminCommandPalette';

afterEach(cleanup);

describe('LazyAdminCommandPalette when the chunk fails', () => {
  it('says so, logs it, holds focus in the dialog, closes on Escape, and the next open retries', async () => {
    const onClose = vi.fn();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const { rerender } = render(<LazyAdminCommandPalette isOpen onClose={onClose} />);
    expect((await screen.findByRole('alert')).textContent).toBe(SEARCH_UNAVAILABLE);
    expect(SEARCH_UNAVAILABLE).toBe('Search unavailable, reload the page');
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(h.warn).toHaveBeenCalledWith('Could not load the admin command palette', expect.anything(), 'admin-ui');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();

    rerender(<LazyAdminCommandPalette isOpen={false} onClose={onClose} />);
    rerender(<LazyAdminCommandPalette isOpen onClose={onClose} />);
    expect(await screen.findByTestId('real-palette')).toBeTruthy();
    expect(h.attempts).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    outside.remove();
  });
});
