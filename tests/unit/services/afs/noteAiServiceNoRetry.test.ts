/**
 * R-175: the note writer's Anthropic client does not retry. With the SDK's
 * default (2 retries on 408/409/429/5xx/529), an attempt that did the work and
 * a final 529 would be judged by the 529 alone and the daily AI unit given
 * back. The real SDK runs here against a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { RequestContext } from '@/lib/als';

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const overloaded = () => answer(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
const ok = () => answer(200, {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'narrative' }], usage: { input_tokens: 1, output_tokens: 1 },
});

async function run(): Promise<{ used: number; threw: boolean }> {
  // After resetModules: the same module instances the service will see.
  const { als } = await import('@/lib/als');
  const { generateNoteNarrative } = await import('@/modules/accounting/services/afs/noteAiService');
  const ctx: RequestContext = {
    client: {} as RequestContext['client'], userId: 'u', claims: {},
    quotaCharges: [{ kind: 'ai', key: 'ai:afs-ai-narrative:co:c:day', charged: 1, used: 0, windowStart: null }],
  };
  let threw = false;
  await als.run(ctx, () => generateNoteNarrative('ppe' as never, { title: 'PPE', blocks: [] } as never, '{tables}',
    { name: 'Co', framework: 'ifrs_smes', fiscalYear: 2025 } as never)).catch(() => { threw = true; });
  return { used: ctx.quotaCharges![0]!.used, threw };
}

describe('noteAiService — one attempt, judged on its own answer (R-175)', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a 529 is not retried: one request, no use', async () => {
    fetchMock.mockResolvedValueOnce(overloaded()).mockResolvedValue(ok());

    expect(await run()).toEqual({ used: 0, threw: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 500 is not retried either: one request, counted as use', async () => {
    fetchMock.mockResolvedValueOnce(answer(500, { type: 'error', error: { type: 'api_error', message: 'x' } })).mockResolvedValue(ok());

    expect(await run()).toEqual({ used: 1, threw: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a success is one request and one unit used', async () => {
    fetchMock.mockResolvedValue(ok());

    expect(await run()).toEqual({ used: 1, threw: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
