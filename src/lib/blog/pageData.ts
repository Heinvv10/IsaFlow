/**
 * Props for the blog pages, built in getStaticProps. Every value is JSON-serialisable
 * (null, never undefined). The publishing gate is applied here: a post that is not
 * viewable for (now, preview) is absent from the index and its page returns null (404).
 */
import { findPost, loadAllPosts, type BlogPost, type LoadOptions } from './content';
import { categoryKey } from './format';
import { renderMdxToHtml } from './renderMdx';
import { blogStatus, isViewable, type BlogStatus } from './visibility';

export interface PostSummary {
  slug: string;
  title: string;
  description: string;
  category: string;
  categoryKey: string;
  tags: string[];
  heroImage: string;
  heroAlt: string;
  publishDate: string;
  updatedDate: string | null;
  readingTimeMinutes: number;
  status: BlogStatus;
}

export interface PostPageData {
  post: PostSummary & { author: string; ogImage: string };
  html: string;
  related: PostSummary[];
}

export interface IndexData {
  posts: PostSummary[];
  categories: { key: string; name: string; count: number }[];
}

export function toSummary(p: BlogPost, now: Date): PostSummary {
  const fm = p.frontmatter;
  return {
    slug: fm.slug,
    title: fm.title,
    description: fm.description,
    category: fm.category,
    categoryKey: categoryKey(fm.category),
    tags: fm.tags,
    heroImage: fm.heroImage,
    heroAlt: fm.heroAlt,
    publishDate: fm.publishDate,
    updatedDate: fm.updatedDate ?? null,
    readingTimeMinutes: p.readingTimeMinutes,
    status: blogStatus(fm, now),
  };
}

function viewable(posts: BlogPost[], now: Date, preview: boolean): BlogPost[] {
  return posts.filter((p) => isViewable(p.frontmatter, now, preview));
}

export function getIndexData(now: Date, preview: boolean, options: LoadOptions = {}): IndexData {
  const posts = viewable(loadAllPosts(options), now, preview).map((p) => toSummary(p, now));
  const byKey = new Map<string, { key: string; name: string; count: number }>();
  for (const p of posts) {
    const c = byKey.get(p.categoryKey) ?? { key: p.categoryKey, name: p.category, count: 0 };
    c.count += 1;
    byKey.set(p.categoryKey, c);
  }
  return { posts, categories: [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Slugs to prerender at build time: the published ones only (preview pages render on demand). */
export function getStaticSlugs(now: Date, options: LoadOptions = {}): string[] {
  return viewable(loadAllPosts(options), now, false).map((p) => p.frontmatter.slug);
}

export async function getPostPageData(
  slug: string,
  now: Date,
  preview: boolean,
  options: LoadOptions = {},
): Promise<PostPageData | null> {
  const all = loadAllPosts(options);
  const found = findPost(all, slug);
  if (!found || !isViewable(found.frontmatter, now, preview)) return null;
  const html = await renderMdxToHtml(found.body, found.sourcePath);
  const others = viewable(all, now, preview).filter((p) => p.frontmatter.slug !== slug);
  const sameCategory = others.filter((p) => p.frontmatter.category === found.frontmatter.category);
  const related = [...sameCategory, ...others.filter((p) => !sameCategory.includes(p))]
    .slice(0, 3)
    .map((p) => toSummary(p, now));
  return {
    post: {
      ...toSummary(found, now),
      author: found.frontmatter.author,
      ogImage: found.frontmatter.ogImage ?? found.frontmatter.heroImage,
    },
    html,
    related,
  };
}
