/**
 * The publishing gate. Production shows a post only when draft is false and its
 * publishDate has passed. Preview (NODE_ENV !== 'production', or BLOG_PREVIEW=1) also
 * shows drafts and scheduled posts, bannered and noindexed. Sitemap and RSS never do.
 */
import { toInstant, type BlogFrontmatter } from './frontmatter';

export type BlogStatus = 'published' | 'draft' | 'scheduled';

type GateFields = Pick<BlogFrontmatter, 'draft' | 'publishDate'>;

export function isPreviewEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.BLOG_PREVIEW === '1';
}

export function blogStatus(fm: GateFields, now: Date): BlogStatus {
  if (fm.draft) return 'draft';
  return toInstant(fm.publishDate).getTime() > now.getTime() ? 'scheduled' : 'published';
}

export function isPublished(fm: GateFields, now: Date): boolean {
  return blogStatus(fm, now) === 'published';
}

export function isViewable(fm: GateFields, now: Date, preview: boolean): boolean {
  return preview || isPublished(fm, now);
}
