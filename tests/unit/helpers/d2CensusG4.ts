// Shared builders for the d2CensusG4* tests: the real apiFetch helpers run over a scripted spy, and each
// converted site gets the same three checks (server message, empty-500 plain sentence, success data).
import { expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';

export const MSG = 'D2 server says no: this could not be done';
export const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const bad = () => new Response(JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: MSG } }), { status: 400 });
export const boom = () => new Response('', { status: 500 });

export type Mode = 'bad' | 'boom' | 'ok';
export type Router = (url: string, init?: RequestInit) => Response | undefined;

export interface Site {
  name: string;
  /** Renders the page/component (called once per test). */
  render: () => unknown;
  /** Does `url` belong to the site under test? */
  match: (url: string, init?: RequestInit) => boolean;
  /** Body of the 200 envelope for the site under test. */
  data: unknown;
  /** Answers every other request the page makes (default: an empty success envelope). */
  others?: Router;
  /** User interaction that triggers the site, when it is not a mount request. */
  drive?: () => Promise<void>;
  /** Plain-sentence fallback shown for an empty 500. */
  plain: string;
  /** Distinctive text from `data` that the page must render on success. */
  success: string | RegExp;
  /** Reset per-test state (call counters) used by `match`. */
  setup?: () => void;
}

const esc = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export function script(site: Site, mode: Mode) {
  site.setup?.();
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (site.match(u, init)) return mode === 'bad' ? bad() : mode === 'boom' ? boom() : ok(site.data);
    return site.others?.(u, init) ?? ok({});
  });
}

export function expectNoRawJsonError() {
  expect(document.body.textContent).not.toMatch(/JSON|Unexpected end/);
}

/** Registers the three tests for one site. */
export function trio(site: Site) {
  it(`${site.name}: shows the server's message on a 400`, async () => {
    script(site, 'bad'); site.render(); await site.drive?.();
    expect((await screen.findAllByText(esc(MSG))).length).toBeGreaterThan(0);
  });
  it(`${site.name}: an empty 500 shows a plain sentence, not a JSON parse error`, async () => {
    script(site, 'boom'); site.render(); await site.drive?.();
    expect((await screen.findAllByText(esc(site.plain))).length).toBeGreaterThan(0);
    expectNoRawJsonError();
  });
  it(`${site.name}: a 200 renders the data`, async () => {
    script(site, 'ok'); site.render(); await site.drive?.();
    expect((await screen.findAllByText(typeof site.success === 'string' ? esc(site.success) : site.success)).length).toBeGreaterThan(0);
  });
}
