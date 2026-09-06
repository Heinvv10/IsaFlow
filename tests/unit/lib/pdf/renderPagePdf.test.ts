/**
 * `renderPagePdf`'s environment contract.
 *
 * BROWSER REVIEW BR4: the pack PDF download needs a SERVER-SIDE `APP_URL` — the
 * origin the headless browser navigates to — and it was absent from
 * `.env.example`, so a fresh checkout's first PDF export 500s. It is distinct
 * from `NEXT_PUBLIC_APP_URL`, which is a build-time value baked into the
 * browser bundle, and it must be reachable FROM the renderer rather than from
 * this process: for Gotenberg that means from inside the container.
 *
 * The reviewer's reading was that the failure is already clear. These cases pin
 * that, so the message an operator greps for cannot quietly become "Invalid
 * URL" from `new URL(undefined)` further down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Neither transport may be reached: the guard is before the browser.
const playwrightRender = vi.fn(async () => Buffer.from('%PDF'));
const gotenbergRender = vi.fn(async () => Buffer.from('%PDF'));
vi.mock('@/lib/pdf/transports/playwrightTransport', () => ({
  playwrightTransport: { name: 'playwright', render: (...a: unknown[]) => playwrightRender(...a) },
}));
vi.mock('@/lib/pdf/transports/gotenbergTransport', () => ({
  gotenbergTransport: { name: 'gotenberg', render: (...a: unknown[]) => gotenbergRender(...a) },
}));

import { renderPagePdf } from '@/lib/pdf/renderPagePdf';

const ORIGINAL = {
  appUrl: process.env.APP_URL,
  publicAppUrl: process.env.NEXT_PUBLIC_APP_URL,
  secret: process.env.PRINT_TOKEN_SECRET,
  transport: process.env.PDF_TRANSPORT,
};

const options = {
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  path: '/accounting/reports/report-packs',
  apiPaths: ['/api/accounting/reports-pack'],
};

beforeEach(() => {
  playwrightRender.mockClear();
  gotenbergRender.mockClear();
  process.env.PRINT_TOKEN_SECRET = 'a'.repeat(32);
  process.env.PDF_TRANSPORT = 'playwright';
});

afterEach(() => {
  for (const [key, value] of [
    ['APP_URL', ORIGINAL.appUrl],
    ['NEXT_PUBLIC_APP_URL', ORIGINAL.publicAppUrl],
    ['PRINT_TOKEN_SECRET', ORIGINAL.secret],
    ['PDF_TRANSPORT', ORIGINAL.transport],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('renderPagePdf — APP_URL', () => {
  it('refuses with a message naming the setting, before launching a browser', async () => {
    delete process.env.APP_URL;
    await expect(renderPagePdf(options)).rejects.toThrow('APP_URL is not set');
    expect(playwrightRender).not.toHaveBeenCalled();
    expect(gotenbergRender).not.toHaveBeenCalled();
  });

  it('does NOT fall back to NEXT_PUBLIC_APP_URL', async () => {
    // That one is a build-time value in the browser bundle, and on a Gotenberg
    // host it is the address the CLIENT uses — not one the container can reach.
    // Falling back to it would produce a render that fails inside the container
    // with a network error instead of a clear refusal here.
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3200';
    await expect(renderPagePdf(options)).rejects.toThrow('APP_URL is not set');
    expect(playwrightRender).not.toHaveBeenCalled();
  });

  it('refuses on a blank APP_URL rather than navigating to a bare path', async () => {
    process.env.APP_URL = '';
    await expect(renderPagePdf(options)).rejects.toThrow('APP_URL is not set');
    expect(playwrightRender).not.toHaveBeenCalled();
  });

  it('builds the render URL from it, with print=1 always added', async () => {
    process.env.APP_URL = 'http://host.docker.internal:3200';
    await renderPagePdf({ ...options, query: { pack: 'management', from: '2026-01-01' } });

    expect(playwrightRender).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://host.docker.internal:3200/accounting/reports/report-packs?pack=management&from=2026-01-01&print=1',
    }));
  });
});
