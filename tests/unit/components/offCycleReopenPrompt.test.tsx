/**
 * Wave 6 OC, review #1620 final breaker M: the reopen dialog of an off-cycle run says that reopening corrects the
 * payroll records only, and that recovering an over-payment from the employee happens outside payroll. A regular
 * run's dialog does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

let loaded: Record<string, unknown> = {};
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  apiJson: vi.fn(async () => loaded),
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, m: string) => m,
  ApiRequestError: class extends Error {},
}));

import { useRunDetail } from '@/components/payroll/useRunDetail';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function promptFor(runKind: string): Promise<string> {
  loaded = { id: 'run-1', status: 'approved', runKind, lines: [] };
  const prompt = vi.fn(() => null);
  vi.stubGlobal('prompt', prompt);
  window.prompt = prompt; // the hook reads window.prompt
  const { result } = renderHook(() => useRunDetail('run-1'));
  await waitFor(() => expect(result.current.run).not.toBeNull());
  await act(async () => { await result.current.reopen(); });
  return String((prompt.mock.calls[0] as unknown[] | undefined)?.[0]);
}

describe('the reopen dialog', () => {
  it('for an off-cycle run says cash recovery from the employee happens outside payroll', async () => {
    expect(await promptFor('off_cycle')).toMatch(/Recovering an over-payment from the employee happens outside payroll\./);
  });
  it('for a regular run says nothing of the kind', async () => {
    expect(await promptFor('regular')).not.toMatch(/outside payroll/);
  });
});
