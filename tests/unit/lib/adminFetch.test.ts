/** adminFetch always sends X-Admin-Request (withAdmin 403s any non-GET without it), keeps the caller's headers and options. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminFetch } from '@/lib/admin/adminFetch';

function stubFetch(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe('adminFetch', () => {
  it('adds X-Admin-Request: true when the caller passed no headers', async () => {
    const f = stubFetch();
    await adminFetch('/api/admin/x', { method: 'POST' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/x');
    expect(new Headers(init.headers).get('X-Admin-Request')).toBe('true');
    expect(init.method).toBe('POST');
  });

  it('keeps caller headers and body, and adds the header on a bare GET', async () => {
    const f = stubFetch();
    await adminFetch('/api/admin/y', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    await adminFetch('/api/admin/z');
    const [, patch] = f.mock.calls[0] as unknown as [string, RequestInit];
    const [, get] = f.mock.calls[1] as unknown as [string, RequestInit];
    const h = new Headers(patch.headers);
    expect([h.get('Content-Type'), h.get('X-Admin-Request'), patch.body]).toEqual(['application/json', 'true', '{"a":1}']);
    expect(new Headers(get.headers).get('X-Admin-Request')).toBe('true');
  });
});
