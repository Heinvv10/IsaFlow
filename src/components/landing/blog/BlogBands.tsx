/**
 * The dark hero bands of the blog index and of a post (breadcrumb, title, meta). They
 * live here because display sizes (text-4xl+) are allowed on landing components only.
 */
import { Rss } from 'lucide-react';
import { BLOG_DESCRIPTION, BLOG_RSS_PATH } from '@/lib/blog/constants';
import { formatBlogDate, isoInstant } from '@/lib/blog/format';
import type { PostPageData } from '@/lib/blog/pageData';
import { Breadcrumb, Chip, PreviewBanner } from './BlogShell';

export function IndexBand() {
  return (
    <>
      <Breadcrumb trail={[{ name: 'Home', href: '/' }, { name: 'Blog' }]} />
      <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-teal-400">The ISAFlow Blog</p>
      <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">
        Guides for running the numbers of a South African business
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-white/70">{BLOG_DESCRIPTION}</p>
      <a
        href={BLOG_RSS_PATH}
        className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-teal-300 hover:text-teal-200"
      >
        <Rss className="h-4 w-4" aria-hidden="true" /> Subscribe via RSS
      </a>
    </>
  );
}

export function PostBand({ post }: { post: PostPageData['post'] }) {
  return (
    <div className="max-w-3xl">
      <Breadcrumb trail={[{ name: 'Home', href: '/' }, { name: 'Blog', href: '/blog' }, { name: post.title }]} />
      <PreviewBanner status={post.status} publishDate={post.publishDate} />
      <div className="mb-5">
        <Chip tone="dark" href={`/blog?category=${post.categoryKey}`}>
          {post.category}
        </Chip>
      </div>
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">{post.title}</h1>
      <p className="mt-5 text-lg text-white/70">{post.description}</p>
      <p className="mt-6 flex flex-wrap gap-x-3 gap-y-1 text-sm text-white/70">
        <span className="font-semibold text-white">{post.author}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={isoInstant(post.publishDate)}>{formatBlogDate(post.publishDate)}</time>
        {post.updatedDate && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              Updated <time dateTime={isoInstant(post.updatedDate)}>{formatBlogDate(post.updatedDate)}</time>
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span>{post.readingTimeMinutes} min read</span>
      </p>
    </div>
  );
}
