/**
 * A `@/lib/apiFetch` mock for component tests that script `apiFetch` responses: `apiFetch` is a spy,
 * and `apiJson` is the real contract (assertOk, then the `data` envelope) running over that spy, so
 * pages converted to apiJson/apiErrorMessage can still be driven through `vi.mocked(apiFetch)`.
 * Use: vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
 */
import { vi } from 'vitest';

export async function mockedApiFetchModule() {
  const real = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  const apiFetch = vi.fn();
  const apiJson = async (url: string, options?: RequestInit) => {
    const res = (await apiFetch(url, options)) as Response;
    await real.assertOk(res, `Request to ${url} failed`);
    const parsed = JSON.parse(await res.text()) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
      throw new real.ApiEnvelopeError(`${url} returned a body without a 'data' envelope`);
    }
    return (parsed as { data: unknown }).data;
  };
  return { ...real, apiFetch, apiJson };
}
