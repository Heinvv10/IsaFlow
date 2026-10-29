/** JSON-LD builders for blog pages (Article, Blog, BreadcrumbList). */
import {
  BLOG_DESCRIPTION, BLOG_TITLE, BLOG_URL, PUBLISHER_LOGO, PUBLISHER_NAME, SITE_URL,
} from './constants';
import type { BlogFrontmatter } from './frontmatter';
import { isoInstant } from './format';

export const absoluteUrl = (sitePath: string): string => `${SITE_URL}${sitePath}`;

const publisher = {
  '@type': 'Organization',
  name: PUBLISHER_NAME,
  url: SITE_URL,
  logo: { '@type': 'ImageObject', url: PUBLISHER_LOGO },
};

export function breadcrumbJsonLd(trail: { name: string; url: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: t.url })),
  };
}

export type ArticleLdInput = Pick<
  BlogFrontmatter,
  'title' | 'description' | 'heroImage' | 'publishDate' | 'author' | 'category' | 'tags'
> & { ogImage?: string | null; updatedDate?: string | null };

export function articleJsonLd(fm: ArticleLdInput, url: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: fm.title,
    description: fm.description,
    image: [absoluteUrl(fm.heroImage), ...(fm.ogImage && fm.ogImage !== fm.heroImage ? [absoluteUrl(fm.ogImage)] : [])],
    datePublished: isoInstant(fm.publishDate),
    dateModified: isoInstant(fm.updatedDate ?? fm.publishDate),
    author: { '@type': 'Organization', name: fm.author, url: SITE_URL },
    publisher,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    articleSection: fm.category,
    keywords: fm.tags.join(', '),
  };
}

export function blogIndexJsonLd(posts: { title: string; slug: string; publishDate: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': ['Blog', 'CollectionPage'],
    name: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    url: BLOG_URL,
    publisher,
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: `${BLOG_URL}/${p.slug}`,
      datePublished: isoInstant(p.publishDate),
    })),
  };
}

/** Serialise JSON-LD for a <script> body without letting "</script>" close it early. */
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
