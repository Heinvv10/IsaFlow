/**
 * Shared fake API for the return lifecycle component tests (wave 5 L2). Each test file mocks @/lib/apiFetch with its
 * own hoisted `apiFetch` and calls installReturnApi(apiFetch) in beforeEach; the tests then steer `h`.
 */
import { screen, waitFor } from '@testing-library/react';
import { expect, type Mock } from 'vitest';

export const P = { periodStart: '2026-07-01', periodEnd: '2026-08-31' };
export const V1 = {
  id: '11111111-1111-4111-8111-111111111111', formType: 'VAT201', ...P, versionNo: 1, status: 'finalised',
  figures: { outputTax: 1500, inputTax: 300, netVat: 1200, sarsFields: [] } as Record<string, unknown>, postedThrough: '2026-09-01',
  vatPeriodLockId: 'lock-1' as string | null, sarsSubmissionId: null, filedReference: null as string | null, amendsVersionId: null as string | null,
  finalisedBy: 'u-owner', finalisedAt: '2026-09-02T10:00:00Z', filedBy: null as string | null, filedAt: null as string | null,
  amendedBy: null as string | null, amendReason: null as string | null, amendedAt: null as string | null,
  drift: { drifted: false, fields: [], changed: [], unfinalRuns: 0 } as unknown, lockRemoved: false,
};

export type Reply = { status: number; body: unknown };

export const h = {
  versions: [] as unknown[],
  posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
  postReplies: [] as Reply[],
  /** Versions per periodStart, when a test needs two periods; otherwise `versions`. */
  byPeriod: {} as Record<string, unknown[]>,
  versionsFail: false,
  /** Hold every versions response until release() is called (to look at the screen mid-load). */
  hold: false,
  held: [] as Array<() => void>,
};

const json = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });

export function installReturnApi(apiFetch: Mock): void {
  Object.assign(h, { versions: [], posts: [], postReplies: [], byPeriod: {}, versionsFail: false, hold: false, held: [] });
  document.cookie = 'is_impersonating=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      h.posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json(h.postReplies.shift() ?? { status: 200, body: { success: true, data: {} } });
    }
    if (url.includes('/versions?')) {
      if (h.hold) await new Promise<void>((r) => h.held.push(r));
      if (h.versionsFail) return json({ status: 500, body: { success: false, error: { message: 'The versions could not be read.' } } });
      const start = new URL(url, 'http://x').searchParams.get('periodStart') ?? '';
      return json({ status: 200, body: { success: true, data: { versions: h.byPeriod[start] ?? h.versions, vatReturn: null } } });
    }
    if (url.startsWith('/api/accounting/company-users')) {
      return json({ status: 200, body: { success: true, data: [{ userId: 'u-owner', name: 'Olive Owner' }] } });
    }
    throw new Error(`unexpected ${url}`);
  });
}

export const ready = () => waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).not.toBe('Loading…'));
export const button = (name: RegExp) => screen.queryByRole('button', { name });
export const refusal = (status: number, message: string, details?: Record<string, unknown>): Reply =>
  ({ status, body: { success: false, error: { code: 'X', message, ...(details ? { details } : {}) } } });
