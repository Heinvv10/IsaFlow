import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatBlogDate, isoInstant } from '@/lib/blog/format';
import type { PostSummary } from '@/lib/blog/pageData';

function Meta({ post }: { post: PostSummary }) {
  return (
    <p className="text-sm text-slate-600">
      <time dateTime={isoInstant(post.publishDate)}>{formatBlogDate(post.publishDate)}</time>
      <span aria-hidden="true"> · </span>
      {post.readingTimeMinutes} min read
      {post.status !== 'published' && (
        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold uppercase text-amber-800">{post.status}</span>
      )}
    </p>
  );
}

/** A post in the index grid; `featured` renders the newest post as a wide card. */
export function PostCard({ post, featured = false }: { post: PostSummary; featured?: boolean }) {
  return (
    <article
      className={`group relative flex overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-900/5 ${
        featured ? 'flex-col lg:flex-row' : 'flex-col'
      }`}
    >
      <div className={`relative aspect-[16/9] overflow-hidden bg-slate-100 ${featured ? 'lg:w-3/5 lg:aspect-auto' : ''}`}>
        <Image
          src={post.heroImage}
          alt={post.heroAlt}
          fill
          priority={featured}
          sizes={featured ? '(min-width: 1024px) 600px, 100vw' : '(min-width: 1024px) 320px, (min-width: 640px) 50vw, 100vw'}
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
        />
      </div>
      <div className={`flex flex-1 flex-col gap-3 p-6 ${featured ? 'lg:p-10 lg:justify-center' : ''}`}>
        <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">{post.category}</p>
        <h2 className={`font-bold tracking-tight text-slate-900 ${featured ? 'text-2xl lg:text-3xl' : 'text-xl'}`}>
          <Link href={`/blog/${post.slug}`} className="after:absolute after:inset-0 focus:outline-none">
            {post.title}
          </Link>
        </h2>
        <p className="text-slate-700 leading-relaxed line-clamp-3">{post.description}</p>
        <div className="mt-auto flex items-center justify-between pt-2">
          <Meta post={post} />
          <ArrowRight className="h-4 w-4 text-teal-700 transition-transform group-hover:translate-x-1" aria-hidden="true" />
        </div>
      </div>
    </article>
  );
}
