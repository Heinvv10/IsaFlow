import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ask/askAnswer', () => ({ answerQuestion: vi.fn() }));

import handler from '../../../../pages/api/accounting/ask';

describe('GET /api/accounting/ask?mode=free', () => {
  it('refuses with 400 "not enabled" and makes no outbound call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    await (handler as unknown as (a: unknown, b: unknown) => Promise<unknown>)(
      { method: 'GET', query: { q: 'anything at all', mode: 'free' }, companyId: 'co' }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res.json.mock.calls)).toContain('not enabled');
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
