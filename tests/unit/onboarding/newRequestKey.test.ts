/**
 * The wizard's request key must be a v4 UUID (the server refuses anything else) even on a
 * plain-http origin, where crypto.randomUUID does not exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newRequestKey } from '@/components/onboarding/submitOnboardingSetup';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
afterEach(() => { vi.unstubAllGlobals(); });

describe('newRequestKey', () => {
  it('uses crypto.randomUUID when there is one', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555' });
    expect(newRequestKey()).toBe('11111111-2222-4333-8444-555555555555');
  });
  it('without randomUUID (non-secure origin) builds a v4 UUID from getRandomValues', () => {
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => b.fill(0xff) });
    expect(newRequestKey()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
  it('without any crypto it still returns distinct v4 UUIDs', () => {
    vi.stubGlobal('crypto', undefined);
    const a = newRequestKey(); const b = newRequestKey();
    expect(a).toMatch(V4); expect(b).toMatch(V4); expect(a).not.toBe(b);
  });
});
