/** Scripts the mocked `apiFetch` for the d2 round 3 (a1) tests and checks what a user must never read. */
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export const MSG = 'D2 server says no: this request was refused';
export const ok = (data: unknown = {}) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const bad = (status = 400) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status });
export const empty500 = () => new Response('', { status: 500 });

/** Every request goes to `handler(url, method)`; a fresh Response per call (a body reads once). */
export function route(handler: (url: string, method: string) => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => handler(String(url), (init?.method ?? 'GET').toUpperCase()));
}

/** True when no raw technical text (JSON parse errors, HTTP codes, a bare "Failed") is on the page. */
export function noRawText(): boolean {
  if (/JSON|Unexpected end|HTTP \d/.test(document.body.textContent ?? '')) return false;
  return [...document.querySelectorAll('*')].every(e => e.children.length > 0 || e.textContent?.trim() !== 'Failed');
}
export const spinning = () => document.querySelector('.animate-spin') !== null;
