/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * A pages fetch that fails must tell the renderer, or a refusing tenant holds
 * a render slot for the whole print-ready timeout. The status goes in the
 * attribute; the response body does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/components/charts/EChartClient', () => ({ EChartClient: () => <div /> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { PackPagesPrintPage } from '@/components/accounting/packs/PackPagesPrintPage';

const attr = () => document.documentElement.getAttribute('data-print-error');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-print-error');
  document.documentElement.className = '';
  window.localStorage.clear();
});

describe('PackPagesPrintPage when the pages fetch fails', () => {
  it('marks a 422 refusal with its status and not its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Acme (Pty) Ltd has a balance that does not foot' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )));
    render(<PackPagesPrintPage packType="board" from="2026-01-01" to="2026-08-31" />);
    await waitFor(() => expect(attr()).toBe('pages: HTTP 422'));
    expect(attr()).not.toContain('Acme');
  });

  it('marks a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    render(<PackPagesPrintPage packType="board" from="2026-01-01" to="2026-08-31" />);
    await waitFor(() => expect(attr()).toBe('pages: socket hang up'));
  });
});
