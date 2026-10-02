// Shared response builders for the d2CensusG2* tests (real apiFetch helpers run over the scripted spy).
import { expect, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export const MSG = 'D2 server says no: this company is locked for the period';
export const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const bad = () => new Response(JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: MSG } }), { status: 400 });
export const boom = () => new Response('', { status: 500 });

/** Requests whose URL contains (or satisfies) `match` get `respond()`; every other request gets `base(url)` (default: an empty list). */
export function script(match: string | ((u: string) => boolean), respond: () => Response, base: (u: string) => Response = () => ok([])) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => ((typeof match === 'string' ? String(url).includes(match) : match(String(url))) ? respond() : base(String(url))));
}

/** The raw browser parse error must never reach the user. */
export function expectNoRawJsonError() {
  expect(document.body.textContent).not.toMatch(/JSON|Unexpected end/);
}
