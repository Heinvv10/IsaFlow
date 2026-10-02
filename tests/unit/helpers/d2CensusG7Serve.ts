/** Scripts the mocked `apiFetch` for the d2 census group 7 tests: one URL fragment misbehaves, the rest answer empty. */
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export const MSG = 'D2 server says no: this request was refused';
export type Kind = 'ok' | 'bad' | 'empty500';

export const envelope = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** `okBody` is the envelope `data` served on success; `others` is `data` for every other request. */
export function serve(match: string, kind: Kind, okBody: unknown, others: unknown = []) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    if (!String(url).includes(match)) return envelope({ success: true, data: others });
    if (kind === 'ok') return envelope({ success: true, data: okBody });
    if (kind === 'bad') return envelope({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }, 400);
    return new Response('', { status: 500 });
  });
}

export const NO_RAW = () => {
  const text = document.body.textContent ?? '';
  return !/JSON|Unexpected end/.test(text);
};

export type Rule = [match: string, answer: () => Response];

/** First rule whose fragment is in the URL answers; anything else gets an empty success envelope. */
export function serveRoutes(rules: Rule[], others: unknown = []) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const hit = rules.find(([m]) => String(url).includes(m));
    return hit ? hit[1]() : envelope({ success: true, data: others });
  });
}

/** The response `kind` stands for: 200 with `okBody`, 400 with the real error envelope, or an empty 500. */
export function respond(kind: Kind, okBody: unknown = {}): Response {
  if (kind === 'ok') return envelope({ success: true, data: okBody });
  if (kind === 'bad') return envelope({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }, 400);
  return new Response('', { status: 500 });
}
