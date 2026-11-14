/**
 * #1373 re-review LOW: when the admin palette's chunk cannot load (a deploy replaced it, the network dropped),
 * Ctrl+K must say so and log it, not open nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: h.warn, debug: vi.fn() } }));
vi.mock('@/components/admin/AdminCommandPalette', () => { throw new Error('ChunkLoadError: Loading chunk 4711 failed.'); });

import { LazyAdminCommandPalette, SEARCH_UNAVAILABLE } from '@/components/admin/LazyAdminCommandPalette';

afterEach(cleanup);

describe('LazyAdminCommandPalette when the chunk fails', () => {
  it('shows "Search unavailable, reload the page" in the palette, logs a warning, and Escape still closes it', async () => {
    const onClose = vi.fn();
    render(<LazyAdminCommandPalette isOpen onClose={onClose} />);
    expect((await screen.findByRole('alert')).textContent).toBe(SEARCH_UNAVAILABLE);
    expect(SEARCH_UNAVAILABLE).toBe('Search unavailable, reload the page');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    await waitFor(() => expect(h.warn).toHaveBeenCalledWith('Could not load the admin command palette', expect.anything(), 'admin-ui'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
