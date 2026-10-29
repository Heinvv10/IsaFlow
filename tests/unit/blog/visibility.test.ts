import { afterAll, describe, expect, it } from 'vitest';
import { getIndexData, getPostPageData, getStaticSlugs } from '@/lib/blog/pageData';
import { blogStatus, isPreviewEnabled, isPublished, isViewable } from '@/lib/blog/visibility';
import { makeBlogFixture, removeFixture } from './blogFixtures';

const NOW = new Date('2026-10-27T10:00:00Z'); // 12:00 SAST

describe('blog publishing gate', () => {
  it('draft wins over a past date; a future date is scheduled; otherwise published', () => {
    expect(blogStatus({ draft: true, publishDate: '2020-01-01' }, NOW)).toBe('draft');
    expect(blogStatus({ draft: false, publishDate: '2026-10-28' }, NOW)).toBe('scheduled');
    expect(blogStatus({ draft: false, publishDate: '2026-10-27' }, NOW)).toBe('published');
  });

  it('a date-only post goes live at 00:00 SAST that day', () => {
    const fm = { draft: false, publishDate: '2026-10-28' };
    expect(isPublished(fm, new Date('2026-10-27T21:59:59Z'))).toBe(false);
    expect(isPublished(fm, new Date('2026-10-27T22:00:00Z'))).toBe(true);
  });

  it('a datetime post goes live at that instant', () => {
    const fm = { draft: false, publishDate: '2026-10-27T14:00:00+02:00' };
    expect(isPublished(fm, new Date('2026-10-27T11:59:00Z'))).toBe(false);
    expect(isPublished(fm, new Date('2026-10-27T12:00:00Z'))).toBe(true);
  });

  it('preview is off in production unless BLOG_PREVIEW=1', () => {
    expect(isPreviewEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isPreviewEnabled({ NODE_ENV: 'production', BLOG_PREVIEW: 'true' })).toBe(false);
    expect(isPreviewEnabled({ NODE_ENV: 'production', BLOG_PREVIEW: '1' })).toBe(true);
    expect(isPreviewEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isPreviewEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('drafts and scheduled posts are viewable only in preview', () => {
    for (const fm of [{ draft: true, publishDate: '2026-01-01' }, { draft: false, publishDate: '2027-01-01' }]) {
      expect(isViewable(fm, NOW, false)).toBe(false);
      expect(isViewable(fm, NOW, true)).toBe(true);
    }
  });
});

describe('blog page data honours the gate', () => {
  const f = makeBlogFixture([
    { slug: 'live-post', fm: { publishDate: '2026-10-01', category: 'Payroll' } },
    { slug: 'draft-post', fm: { publishDate: '2026-09-01', draft: true } },
    { slug: 'future-post', fm: { publishDate: '2026-12-01' } },
  ]);
  const opts = { contentDir: f.contentDir, publicDir: f.publicDir };
  afterAll(() => removeFixture(f.root));

  it('production: index and static paths list only the published post', () => {
    expect(getIndexData(NOW, false, opts).posts.map((p) => p.slug)).toEqual(['live-post']);
    expect(getStaticSlugs(NOW, opts)).toEqual(['live-post']);
  });

  it('production: a draft or future post page is a 404 (null)', async () => {
    expect(await getPostPageData('draft-post', NOW, false, opts)).toBeNull();
    expect(await getPostPageData('future-post', NOW, false, opts)).toBeNull();
    expect(await getPostPageData('missing-post', NOW, false, opts)).toBeNull();
    expect((await getPostPageData('live-post', NOW, false, opts))?.post.status).toBe('published');
  });

  it('a scheduled post appears once its date has passed', async () => {
    const later = new Date('2026-12-01T00:00:00+02:00');
    expect(getIndexData(later, false, opts).posts.map((p) => p.slug)).toEqual(['future-post', 'live-post']);
    expect((await getPostPageData('future-post', later, false, opts))?.post.status).toBe('published');
  });

  it('preview: every post is listed and renders with its status', async () => {
    const idx = getIndexData(NOW, true, opts);
    expect(idx.posts.map((p) => [p.slug, p.status])).toEqual([
      ['future-post', 'scheduled'],
      ['live-post', 'published'],
      ['draft-post', 'draft'],
    ]);
    expect((await getPostPageData('draft-post', NOW, true, opts))?.post.status).toBe('draft');
    // Static paths never prerender a preview-only post.
    expect(getStaticSlugs(NOW, opts)).toEqual(['live-post']);
  });

  it('post data is serialisable and related posts exclude the post itself', async () => {
    const data = await getPostPageData('live-post', NOW, true, opts);
    expect(data).not.toBeNull();
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(data?.post.ogImage).toBe('/blog/live-post/hero.webp');
    expect(data?.related.map((p) => p.slug)).not.toContain('live-post');
    expect(data?.html).toContain('<strong>world</strong>');
  });

  it('groups categories with counts', () => {
    expect(getIndexData(NOW, true, opts).categories).toEqual([
      { key: 'payroll', name: 'Payroll', count: 1 },
      { key: 'vat-tax', name: 'VAT & Tax', count: 2 },
    ]);
  });
});
