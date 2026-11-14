import { describe, it, expect, vi, beforeEach } from 'vitest';

const answer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ask/askAnswer', () => ({ answerQuestion: answer }));

import handler from '../../../../pages/api/accounting/ask';

type Call = (req: unknown, res: unknown) => Promise<unknown>;
const run = async (req: Record<string, unknown>) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn(), end: vi.fn().mockReturnThis() };
  await (handler as unknown as Call)({ method: 'GET', query: {}, companyId: 'session-co', ...req }, res);
  return res;
};
const body = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls);

beforeEach(() => { answer.mockReset(); answer.mockResolvedValue({ understood: true, text: 'ok' }); vi.unstubAllGlobals(); });

describe('GET /api/accounting/ask', () => {
  it('405 for anything but GET', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await run({ method, query: { q: 'who owes me money' } })).status).toHaveBeenCalledWith(405);
    expect(answer).not.toHaveBeenCalled();
  });
  it('400 without q, with blank q and with q over 300 characters', async () => {
    for (const q of [undefined, '   ', 'x'.repeat(301)]) expect((await run({ query: q === undefined ? {} : { q } })).status).toHaveBeenCalledWith(400);
    expect(answer).not.toHaveBeenCalled();
  });
  it('accepts exactly 300 characters', async () => {
    expect((await run({ query: { q: 'x'.repeat(300) } })).status).toHaveBeenCalledWith(200);
  });
  it('the company is the session\'s; a companyId in the query is ignored', async () => {
    await run({ query: { q: 'who owes me money', companyId: 'attacker-co', company_id: 'attacker-co' } });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]![0]).toBe('session-co');
  });
  it('is never cached', async () => {
    const res = await run({ query: { q: 'who owes me money' } });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
  it('mode=free is refused with 400 "not enabled" and makes no outbound call, with the provider unset', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const res = await run({ query: { q: 'anything at all', mode: 'free' } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(body(res)).toContain('not enabled');
    expect(answer).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});
