/**
 * Review #1679 codex N8: switching the off-cycle form's regular run clears the previous run's roster and its error, so
 * a failed lookup never leaves the last run's people on screen, and a good one clears the last failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: Response, m: string) => { if (!res.ok) throw new Error(m); },
  apiErrorMessage: (_e: unknown, m: string) => m,
}));

import { useRunPeople } from '@/components/payroll/offCycle/useOffCycleSources';

const lines = [{ employeeId: 'e1', employeeNumber: 'E1', employeeName: 'Thandi Mokoena' }];
afterEach(() => { cleanup(); apiFetch.mockReset(); });

describe('useRunPeople: a new regular run', () => {
  it('clears the roster on a failed lookup, and the error on a good one', async () => {
    apiFetch.mockImplementation(async (url: string) => (url.endsWith('/bad')
      ? new Response('{}', { status: 500 })
      : new Response(JSON.stringify({ data: { lines } }), { status: 200 })));
    const { result, rerender } = renderHook(({ id }) => useRunPeople(id), { initialProps: { id: 'good' as string | null } });
    await waitFor(() => expect(result.current.people).toHaveLength(1));
    rerender({ id: 'bad' });
    await waitFor(() => expect(result.current.error).not.toBe(''));
    expect(result.current.people).toEqual([]);
    rerender({ id: 'good' });
    await waitFor(() => expect(result.current.people).toHaveLength(1));
    expect(result.current.error).toBe('');
  });
});
