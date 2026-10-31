/**
 * sitemap.xml and RSS 2.0 builders. Both list published posts only: drafts and
 * scheduled posts are excluded even when preview is on.
 */
import type { BlogPost } from './content';
import type { HelpDocument } from '@/lib/help/content';
import { BLOG_DESCRIPTION, BLOG_RSS_PATH, BLOG_TITLE, BLOG_URL, SITE_URL } from './constants';
import { escapeXml, isoInstant } from './format';
import { toInstant } from './frontmatter';
import { isPublished } from './visibility';

/** Public marketing pages on isaflow.co.za (the app host is never in the sitemap). */
export const MARKETING_PAGES = ['/', '/pricing', '/contact', '/privacy', '/terms'] as const;

export const postUrl = (slug: string): string => `${BLOG_URL}/${slug}`;

const lastMod = (p: BlogPost): string => p.frontmatter.updatedDate ?? p.frontmatter.publishDate;

export function publishedPosts(posts: BlogPost[], now: Date): BlogPost[] {
  return posts.filter((p) => isPublished(p.frontmatter, now));
}

export function buildSitemapXml(posts: BlogPost[], now: Date, helpDocuments: HelpDocument[] = []): string {
  const live = publishedPosts(posts, now);
  const urls: string[] = MARKETING_PAGES.map((p) => `  <url><loc>${SITE_URL}${p === '/' ? '/' : p}</loc></url>`);
  const newest = live[0];
  urls.push(`  <url><loc>${BLOG_URL}</loc>${newest ? `<lastmod>${isoInstant(lastMod(newest))}</lastmod>` : ''}</url>`);
  for (const p of live) {
    urls.push(`  <url><loc>${escapeXml(postUrl(p.frontmatter.slug))}</loc><lastmod>${isoInstant(lastMod(p))}</lastmod></url>`);
  }
  if (helpDocuments.length > 0) {
    const latestUpdate = helpDocuments.reduce((latest, document) => (
      toInstant(document.frontmatter.updated) > toInstant(latest) ? document.frontmatter.updated : latest
    ), helpDocuments[0]?.frontmatter.updated ?? '1970-01-01');
    urls.push(`  <url><loc>${SITE_URL}/help</loc><lastmod>${isoInstant(latestUpdate)}</lastmod></url>`);
    for (const document of helpDocuments) {
      urls.push(`  <url><loc>${SITE_URL}/help/${document.frontmatter.slug}</loc><lastmod>${isoInstant(document.frontmatter.updated)}</lastmod></url>`);
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

export function buildRssXml(posts: BlogPost[], now: Date): string {
  const live = publishedPosts(posts, now);
  const items = live.map((p) => {
    const fm = p.frontmatter;
    const url = escapeXml(postUrl(fm.slug));
    const categories = [fm.category, ...fm.tags].map((c) => `      <category>${escapeXml(c)}</category>`);
    return [
      '    <item>',
      `      <title>${escapeXml(fm.title)}</title>`,
      `      <link>${url}</link>`,
      `      <guid isPermaLink="true">${url}</guid>`,
      `      <pubDate>${toInstant(fm.publishDate).toUTCString()}</pubDate>`,
      `      <description>${escapeXml(fm.description)}</description>`,
      ...categories,
      '    </item>',
    ].join('\n');
  });
  const newest = live[0];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(BLOG_TITLE)}</title>`,
    `    <link>${BLOG_URL}</link>`,
    `    <description>${escapeXml(BLOG_DESCRIPTION)}</description>`,
    '    <language>en-za</language>',
    `    <atom:link href="${SITE_URL}${BLOG_RSS_PATH}" rel="self" type="application/rss+xml"/>`,
    ...(newest ? [`    <lastBuildDate>${toInstant(lastMod(newest)).toUTCString()}</lastBuildDate>`] : []),
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
