import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const nextConfig = require('../../../next.config.js') as {
  images?: { unoptimized?: boolean };
};

describe('Next image security stop-gap', () => {
  it('disables the vulnerable Next 14 image optimizer', () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});

type Redirect = { source: string; destination: string; permanent: boolean };
const withRedirects = nextConfig as unknown as { redirects: () => Promise<Redirect[]> };

describe('Bank Feeds folded into Statement Imports', () => {
  it('redirects /accounting/bank-feeds and its sub-paths to Statement Imports, permanently', async () => {
    const redirects = await withRedirects.redirects();
    for (const source of ['/accounting/bank-feeds', '/accounting/bank-feeds/:path*']) {
      const r = redirects.find((x) => x.source === source);
      expect(r, source).toEqual({ source, destination: '/accounting/bank/statements', permanent: true });
    }
  });

  it('never redirects an API route', async () => {
    const redirects = await withRedirects.redirects();
    for (const r of redirects) expect(r.source.startsWith('/api/'), r.source).toBe(false);
  });
});
