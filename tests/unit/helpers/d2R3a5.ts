// Shared builders for the d2R3A5* tests (the real apiFetch helpers run over the scripted apiFetch spy).
import { expect, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export const MSG = 'D2 server says no: this period is locked';
export const ok = (data: unknown = {}) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const refuse = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
export const empty500 = () => new Response('', { status: 500 });

/** Answer every request through `fn(url, method)`; an undefined result is a valid empty envelope. */
export function script(fn: (url: string, method: string) => Response | undefined) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => fn(String(url), (init?.method ?? 'GET').toUpperCase()) ?? ok({}));
}

/** No raw parse error, HTTP code, URL or bare "Failed" may be on screen. */
export function expectNoRawError() {
  expect(document.body.textContent).not.toMatch(/JSON|Unexpected end|HTTP \d|\/api\/|(^|\s)Failed(\s|$)/);
}
