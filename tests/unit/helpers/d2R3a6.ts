/** Shared bits for the d2R3a6*.test.tsx files: real-envelope responses and a url router for the apiFetch spy. */
import { expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';

export const MSG = 'D2 server says no: this request was refused';
export const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const refuse = (m = MSG, status = 400) =>
  new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status });
export const empty500 = () => new Response('', { status: 500 });

export type Route = (url: string, method: string) => Response | undefined | Promise<Response | undefined>;

/** First route that answers wins; anything else gets a valid empty list. */
export function serve(...routes: Route[]) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    for (const r of routes) { const res = await r(String(url), method); if (res) return res; }
    return ok([]);
  });
}

/** Route helper: `on('POST', '/api/x', () => refuse())`. `part` is matched with includes(). */
export const on = (method: string, part: string, answer: () => Response): Route =>
  (url, m) => (m === method && url.includes(part) ? answer() : undefined);

export function writeCalls(method: string, part: string): number {
  return vi.mocked(apiFetch).mock.calls.filter(([u, i]) =>
    String(u).includes(part) && ((i as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method).length;
}

/** No transport jargon on screen: no JSON parse text, no HTTP code, no bare "Failed". */
export function expectNoJargon() {
  expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d/);
  expect(screen.queryByText(/^Failed$/)).toBeNull();
}

/** Models "the write succeeds (200), then the reload of `reloadPart` is refused". */
export function afterWrite(method: string, writePart: string, reloadPart: string): Route[] {
  let done = false;
  return [
    (u, m) => (m === method && u.includes(writePart) ? ((done = true), ok({})) : undefined),
    (u, m) => (done && m === 'GET' && u.includes(reloadPart) ? refuse() : undefined),
  ];
}
