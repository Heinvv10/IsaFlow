/**
 * A `@/lib/apiFetch` mock for component tests that script `apiFetch` responses. `apiFetch` becomes a spy
 * AND is what global `fetch` is stubbed to, so the REAL `apiJson` / `assertOk` / `apiErrorMessage` run on
 * top of it: a component converted to apiJson still goes through `vi.mocked(apiFetch)`, with no
 * re-implementation of the contract here.
 * Use: vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
 */
import { afterEach, beforeEach, vi } from 'vitest';

export async function mockedApiFetchModule() {
  const real = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  const apiFetch = vi.fn();
  // Stub per test and undo after it, so the stub never leaks into another test in the file.
  beforeEach(() => { vi.stubGlobal('fetch', (url: unknown, init?: unknown) => apiFetch(url, init)); });
  afterEach(() => { vi.unstubAllGlobals(); });
  return { ...real, apiFetch };
}
