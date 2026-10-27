/**
 * /blog — the post index on the marketing host. Static with hourly ISR, so a scheduled
 * post appears within BLOG_REVALIDATE_SECONDS of its publishDate. The category filter is
 * client-side and kept in ?category= so a filtered view can be shared.
 */
import { useMemo } from 'react';
import type { GetStaticProps } from 'next';
import { useRouter } from 'next/router';
import { BlogHead } from '@/components/landing/blog/BlogHead';
import { IndexBand } from '@/components/landing/blog/BlogBands';
import { BlogShell } from '@/components/landing/blog/BlogShell';
import { PostCard } from '@/components/landing/blog/PostCard';
import {
  BLOG_DESCRIPTION, BLOG_REVALIDATE_SECONDS, BLOG_TITLE, BLOG_URL, SITE_URL,
} from '@/lib/blog/constants';
import { getIndexData, type IndexData } from '@/lib/blog/pageData';
import { blogIndexJsonLd, breadcrumbJsonLd } from '@/lib/blog/seo';
import { isPreviewEnabled } from '@/lib/blog/visibility';

export const getStaticProps: GetStaticProps<IndexData> = async () => ({
  props: getIndexData(new Date(), isPreviewEnabled()),
  revalidate: BLOG_REVALIDATE_SECONDS,
});

function FilterButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
        active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

export default function BlogIndexPage({ posts, categories }: IndexData) {
  const router = useRouter();
  const raw = router.isReady ? router.query.category : undefined;
  const active = typeof raw === 'string' && categories.some((c) => c.key === raw) ? raw : null;
  const shown = useMemo(() => (active ? posts.filter((p) => p.categoryKey === active) : posts), [posts, active]);

  const select = (key: string | null): void => {
    void router.replace({ pathname: '/blog', query: key ? { category: key } : {} }, undefined, {
      shallow: true,
      scroll: false,
    });
  };

  const [featured, ...rest] = shown;
  const published = posts.filter((p) => p.status === 'published');

  return (
    <>
      <BlogHead
        title={`${BLOG_TITLE} | Accounting, VAT and payroll guides`}
        description={BLOG_DESCRIPTION}
        canonical={BLOG_URL}
        image={`${SITE_URL}/landing-pitch-dark.png`}
        imageAlt="ISAFlow"
        type="website"
        jsonLd={[
          blogIndexJsonLd(published),
          breadcrumbJsonLd([
            { name: 'Home', url: `${SITE_URL}/` },
            { name: 'Blog', url: BLOG_URL },
          ]),
        ]}
      />
      <BlogShell
        band={<IndexBand />}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
          {categories.length > 1 && (
            <div className="mb-10 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
              <FilterButton active={active === null} label="All posts" onClick={() => select(null)} />
              {categories.map((c) => (
                <FilterButton key={c.key} active={active === c.key} label={`${c.name} (${c.count})`} onClick={() => select(c.key)} />
              ))}
            </div>
          )}
          {featured ? (
            <div className="space-y-8">
              <PostCard post={featured} featured />
              {rest.length > 0 && (
                <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                  {rest.map((p) => (
                    <PostCard key={p.slug} post={p} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-3xl border border-dashed border-slate-300 px-6 py-20 text-center">
              <h2 className="text-xl font-semibold text-slate-900">New articles are on the way</h2>
              <p className="mt-2 text-slate-600">Our first guides are being written. Check back soon, or subscribe via RSS.</p>
            </div>
          )}
        </div>
      </BlogShell>
    </>
  );
}
