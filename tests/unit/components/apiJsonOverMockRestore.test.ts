// The helper restores global fetch after every test: a stub must not leak into the next one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
const original = globalThis.fetch;
const leaks: boolean[] = [];
// Registered BEFORE the helper's hooks; vitest runs afterEach hooks in reverse, so this sees the state AFTER the helper's teardown.
afterEach(() => { leaks.push(globalThis.fetch !== original); });
useApiJsonOverMock();

describe('apiJsonOverMock', () => {
  it('stubs fetch during a test', () => {
    expect(globalThis.fetch).not.toBe(original);
  });
  it('stubs again for the next test', () => {
    expect(globalThis.fetch).not.toBe(original);
  });
  it('left no stub behind after either test', () => {
    expect(leaks).toEqual([false, false]);
  });
});
