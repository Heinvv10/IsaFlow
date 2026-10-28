/**
 * The blog and the sitemap live on the marketing host. On app.isaflow.co.za they 308 to
 * https://isaflow.co.za (same path and query); on the marketing host they pass through
 * for anonymous visitors, as do the blog's image assets.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { isMarketingOnlyPath, middleware } from '../../middleware';

const run = (host: string, path: string) =>
  middleware(new NextRequest(`https://${host}${path}`, { headers: { host } }));

describe('middleware — /blog is marketing-host only', () => {
  it.each(['/blog', '/blog/my-post', '/blog/rss.xml', '/blog/my-post/hero.webp', '/sitemap.xml', '/blog?category=vat'])(
    'app host: %s redirects 308 to isaflow.co.za',
    async (path) => {
      const res = await run('app.isaflow.co.za', path);
      expect(res.status).toBe(308);
      expect(res.headers.get('location')).toBe(`https://isaflow.co.za${path}`);
    },
  );

  it.each(['/blog', '/blog/my-post', '/blog/rss.xml', '/sitemap.xml', '/blog/my-post/hero.webp'])(
    'marketing host: %s passes through with no cookie',
    async (path) => {
      const res = await run('isaflow.co.za', path);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-next')).toBe('1');
    },
  );

  it('does not catch look-alike paths', () => {
    expect(isMarketingOnlyPath('/blogger')).toBe(false);
    expect(isMarketingOnlyPath('/accounting/blog')).toBe(false);
    expect(isMarketingOnlyPath('/sitemap.xml.bak')).toBe(false);
  });

  it('leaves the app host root redirect and auth gate alone', async () => {
    expect(new URL((await run('app.isaflow.co.za', '/')).headers.get('location') ?? '').pathname).toBe('/accounting');
    expect(new URL((await run('app.isaflow.co.za', '/accounting')).headers.get('location') ?? '').pathname).toBe('/login');
  });
});
