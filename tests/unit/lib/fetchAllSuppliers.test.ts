import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';

const ALL = Array.from({ length: 450 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));

afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('fetchAllSuppliers', () => {
  it('pages past the 200-row cap and returns every supplier', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const u = new URL(String(url), 'http://x');
      const limit = Number(u.searchParams.get('limit'));
      const page = Number(u.searchParams.get('page'));
      const rows = ALL.slice((page - 1) * limit, page * limit);
      return new Response(JSON.stringify({ success: true, data: { suppliers: rows, total: ALL.length } }), { status: 200 });
    });
    expect((await fetchAllSuppliers()).length).toBe(450);
  });

  it('throws when the route fails instead of returning a silently short list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(fetchAllSuppliers()).rejects.toThrow('HTTP 500');
  });
});
