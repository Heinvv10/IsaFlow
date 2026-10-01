/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * A FONT LOAD THAT REJECTS IS REPORTED, NOT SWALLOWED. `loadFooterFace` and
 * `fonts.load` reject by design. The gate hung on an unhandled rejection with
 * no log, and the failure surfaced only as the renderer's 30 s timeout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { error: logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { usePrintReady } from '@/components/accounting/packs/usePrintMode';

function Probe() {
  const ready = usePrintReady(true, 0);
  return <div data-print-ready={ready ? 'true' : 'false'} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
  document.documentElement.removeAttribute('data-print-error');
  logError.mockClear();
});

describe('usePrintReady when a font load rejects', () => {
  it('logs the failure, marks <html data-print-error>, and stays not-ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('footer face unreachable'); }));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(async () => []), check: () => true, ready: Promise.resolve(null) },
    });
    const { container } = render(<Probe />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-print-error')).toBe('fonts: footer face unreachable');
    });
    expect(logError).toHaveBeenCalledWith(
      'Pack print fonts failed to load', { reason: 'footer face unreachable' }, 'pdf',
    );
    expect(container.querySelector('[data-print-ready="false"]')).not.toBeNull();
    expect(container.querySelector('[data-print-ready="true"]')).toBeNull();
  });

  it('reports a face that resolved but is not available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as Response));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(async () => []), check: () => false, ready: Promise.resolve(null) },
    });
    const { container } = render(<Probe />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-print-error')).toBe(
        'fonts: a declared face is not available after loading',
      );
    });
    expect(container.querySelector('[data-print-ready="true"]')).toBeNull();
  });
});
