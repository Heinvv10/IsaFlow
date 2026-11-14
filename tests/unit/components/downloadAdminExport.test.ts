/**
 * downloadAdminExport takes admin export URLs only (WP10 review rev-1372): anything else throws before any
 * fetch. The check is on the URL as the browser resolves it, so dot-segments (also percent-encoded) and
 * another origin cannot slip a non-admin route past a prefix test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetched = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/admin/adminFetch', () => ({
  adminFetch: vi.fn(async (url: string) => {
    fetched.push(url);
    return new Response('a,b\n', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="x.csv"' } });
  }),
}));

import { downloadAdminExport } from '@/components/admin/downloadAdminExport';

afterEach(() => { fetched.length = 0; vi.restoreAllMocks(); });

describe('downloadAdminExport', () => {
  it.each([
    '/api/auth/logout',
    '/api/admin/../auth/x',
    '/api/admin/%2e%2e/auth/x',
    '/api/admin/./../auth/x',
    '/api/administrator/x',
    'https://evil.invalid/api/admin/audit/export',
    '//evil.invalid/api/admin/audit/export',
  ])('refuses %s and fetches nothing', async (href) => {
    await expect(downloadAdminExport(href, 'f.csv')).rejects.toThrow(/\/api\/admin\//);
    expect(fetched).toEqual([]);
  });

  it('fetches an admin export URL and saves the file', async () => {
    const made = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:wp10');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await downloadAdminExport('/api/admin/audit/export?source=admin', 'f.csv');
    expect(fetched).toEqual(['/api/admin/audit/export?source=admin']);
    expect(made).toHaveBeenCalledTimes(1);
  });
});
