/**
 * /blog/<slug> — one post. Published posts are prerendered; any other slug renders on
 * demand (fallback: 'blocking') and is a 404 unless the post is viewable, so a scheduled
 * post goes live on the first request after its publishDate plus at most one ISR window.
 * The MDX body arrives as HTML compiled in getStaticProps: no MDX runs in the browser.
 */
import Image from 'next/image';
import type { GetStaticPaths, GetStaticProps } from 'next';
import { ArticleBody } from '@/components/landing/blog/ArticleBody';
import { BlogHead } from '@/components/landing/blog/BlogHead';
import { PostBand } from '@/components/landing/blog/BlogBands';
import { BlogShell, Chip } from '@/components/landing/blog/BlogShell';
import { PostCard } from '@/components/landing/blog/PostCard';
import { BLOG_REVALIDATE_SECONDS, BLOG_URL, HERO_SIZE, SITE_URL } from '@/lib/blog/constants';
import { isoInstant } from '@/lib/blog/format';
import { getPostPageData, getStaticSlugs, type PostPageData } from '@/lib/blog/pageData';
import { absoluteUrl, articleJsonLd, breadcrumbJsonLd } from '@/lib/blog/seo';
import { isPreviewEnabled } from '@/lib/blog/visibility';

export const getStaticPaths: GetStaticPaths = async () => ({
  paths: getStaticSlugs(new Date()).map((slug) => ({ params: { slug } })),
  fallback: 'blocking',
});

export const getStaticProps: GetStaticProps<PostPageData, { slug: string }> = async ({ params }) => {
  const data = params ? await getPostPageData(params.slug, new Date(), isPreviewEnabled()) : null;
  if (!data) return { notFound: true, revalidate: BLOG_REVALIDATE_SECONDS };
  return { props: data, revalidate: BLOG_REVALIDATE_SECONDS };
};

export default function BlogPostPage({ post, html, related }: PostPageData) {
  const url = `${BLOG_URL}/${post.slug}`;
  const modified = post.updatedDate ?? post.publishDate;

  return (
    <>
      <BlogHead
        title={`${post.title} | ISAFlow Blog`}
        description={post.description}
        canonical={url}
        image={absoluteUrl(post.ogImage)}
        imageAlt={post.heroAlt}
        type="article"
        article={{
          publishedTime: isoInstant(post.publishDate),
          modifiedTime: isoInstant(modified),
          section: post.category,
          tags: post.tags,
        }}
        jsonLd={[
          articleJsonLd(post, url),
          breadcrumbJsonLd([
            { name: 'Home', url: `${SITE_URL}/` },
            { name: 'Blog', url: BLOG_URL },
            { name: post.title, url },
          ]),
        ]}
        noindex={post.status !== 'published'}
      />
      <BlogShell
        band={<PostBand post={post} />}
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="relative -mt-8 overflow-hidden rounded-3xl border border-slate-200 bg-slate-100 shadow-2xl shadow-slate-900/10">
            <Image
              src={post.heroImage}
              alt={post.heroAlt}
              width={HERO_SIZE.width}
              height={HERO_SIZE.height}
              priority
              sizes="(min-width: 1024px) 1024px, 100vw"
              style={{ width: '100%', height: 'auto' }}
            />
          </div>
        </div>
        <article className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
          <ArticleBody html={html} />
          {post.tags.length > 0 && (
            <div className="mt-14 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-8">
              <span className="mr-1 text-sm font-semibold text-slate-900">Tags</span>
              {post.tags.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>
          )}
        </article>
        {related.length > 0 && (
          <section className="border-t border-slate-200 bg-slate-50 py-16" aria-labelledby="related-heading">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
              <h2 id="related-heading" className="mb-8 text-2xl font-bold tracking-tight text-slate-900">
                Keep reading
              </h2>
              <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                {related.map((p) => (
                  <PostCard key={p.slug} post={p} />
                ))}
              </div>
            </div>
          </section>
        )}
      </BlogShell>
    </>
  );
}
