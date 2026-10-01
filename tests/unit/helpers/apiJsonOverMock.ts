/**
 * A `@/lib/apiFetch` mock for component tests that script `apiFetch` responses. `apiFetch` becomes a spy
 * AND is what global `fetch` is stubbed to, so the REAL `apiJson` / `assertOk` / `apiErrorMessage` run on
 * top of it: a component converted to apiJson still goes through `vi.mocked(apiFetch)`, with no
 * re-implementation of the contract here.
 * Use, in the test file:
 *   vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
 *   useApiJsonOverMock();   // top level: stubs fetch before each test, restores it after
 */
import { afterEach, beforeEach, vi } from 'vitest';

let spy: ReturnType<typeof vi.fn> | null = null;

export async function mockedApiFetchModule() {
  const real = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  spy = vi.fn();
  return { ...real, apiFetch: spy };
}

/** Call at the top level of a test file (never inside the vi.mock factory). */
export function useApiJsonOverMock() {
  beforeEach(() => {
    vi.stubGlobal('fetch', (url: unknown, init?: unknown) => {
      if (!spy) throw new Error('apiJsonOverMock: mockedApiFetchModule() has not run');
      return spy(url, init);
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
}
