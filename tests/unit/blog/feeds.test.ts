import { afterAll, describe, expect, it } from 'vitest';
// xml-js (sax, strict mode) comes with the docx dependency; it throws on malformed XML.
import { xml2js } from 'xml-js';
import { loadAllPosts } from '@/lib/blog/content';
import { buildRssXml, buildSitemapXml } from '@/lib/blog/feeds';
import { loadAllHelpDocuments } from '@/lib/help/content';
import { makeBlogFixture, removeFixture } from './blogFixtures';

const NOW = new Date('2026-10-27T10:00:00Z');
const f = makeBlogFixture([
  { slug: 'live-post', fm: { publishDate: '2026-10-01', updatedDate: '2026-10-20', tags: ['vat', 'sars'], title: 'Tom & Jerry <VAT>' } },
  { slug: 'older-post', fm: { publishDate: '2026-08-01' } },
  { slug: 'draft-post', fm: { publishDate: '2026-09-01', draft: true } },
  { slug: 'future-post', fm: { publishDate: '2026-12-01' } },
]);
afterAll(() => removeFixture(f.root));
const posts = loadAllPosts({ contentDir: f.contentDir, publicDir: f.publicDir });

describe('sitemap.xml', () => {
  const xml = buildSitemapXml(posts, NOW);

  it('is well-formed XML', () => {
    expect(() => xml2js(xml)).not.toThrow();
  });

  it('lists the marketing pages, /blog and every published post with lastmod', () => {
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      'https://isaflow.co.za/',
      'https://isaflow.co.za/pricing',
      'https://isaflow.co.za/contact',
      'https://isaflow.co.za/privacy',
      'https://isaflow.co.za/terms',
      'https://isaflow.co.za/blog',
      'https://isaflow.co.za/blog/live-post',
      'https://isaflow.co.za/blog/older-post',
    ]);
    // lastmod = updatedDate || publishDate, as an instant (date-only = 00:00 SAST)
    expect(xml).toContain('<loc>https://isaflow.co.za/blog/live-post</loc><lastmod>2026-10-19T22:00:00.000Z</lastmod>');
    expect(xml).toContain('<loc>https://isaflow.co.za/blog/older-post</loc><lastmod>2026-07-31T22:00:00.000Z</lastmod>');
  });

  it('never lists drafts or scheduled posts', () => {
    expect(xml).not.toContain('draft-post');
    expect(xml).not.toContain('future-post');
  });

  it('lists a scheduled post after its date', () => {
    expect(buildSitemapXml(posts, new Date('2026-12-02T00:00:00Z'))).toContain('/blog/future-post');
  });

  it('lists the help index, FAQ and every help article', () => {
    const help = loadAllHelpDocuments();
    const helpXml = buildSitemapXml(posts, NOW, help);
    const locs = [...helpXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs.filter((loc) => loc?.includes('/help'))).toEqual([
      'https://isaflow.co.za/help',
      ...help.map((document) => `https://isaflow.co.za/help/${document.frontmatter.slug}`),
    ]);
  });
});

describe('RSS 2.0 feed', () => {
  const xml = buildRssXml(posts, NOW);

  it('is well-formed RSS 2.0 with absolute links', () => {
    const doc = xml2js(xml, { compact: true }) as { rss: { _attributes: { version: string }; channel: { item: unknown[]; link: { _text: string } } } };
    expect(doc.rss._attributes.version).toBe('2.0');
    expect(doc.rss.channel.link._text).toBe('https://isaflow.co.za/blog');
    expect(doc.rss.channel.item).toHaveLength(2);
    const links = [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]);
    expect(links.every((l) => l?.startsWith('https://isaflow.co.za/'))).toBe(true);
  });

  it('carries title (escaped), pubDate, description, guid and categories', () => {
    expect(xml).toContain('<title>Tom &amp; Jerry &lt;VAT&gt;</title>');
    expect(xml).toContain('<pubDate>Wed, 30 Sep 2026 22:00:00 GMT</pubDate>');
    expect(xml).toContain('<description>About live-post.</description>');
    expect(xml).toContain('<guid isPermaLink="true">https://isaflow.co.za/blog/live-post</guid>');
    expect(xml).toContain('<category>VAT &amp; Tax</category>');
    expect(xml).toContain('<category>sars</category>');
  });

  it('excludes drafts and scheduled posts', () => {
    expect(xml).not.toContain('draft-post');
    expect(xml).not.toContain('future-post');
  });
});
