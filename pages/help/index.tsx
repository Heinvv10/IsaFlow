import Link from 'next/link';
import type { GetStaticProps } from 'next';
import { ArrowRight } from 'lucide-react';
import { BlogHead } from '@/components/landing/blog/BlogHead';
import { BlogShell, Breadcrumb } from '@/components/landing/blog/BlogShell';
import { SITE_URL } from '@/lib/blog/constants';
import { breadcrumbJsonLd } from '@/lib/blog/seo';
import { loadAllHelpDocuments, type HelpFrontmatter } from '@/lib/help/content';
import { HELP_DESCRIPTION, HELP_URL } from '@/lib/help/constants';

interface HelpIndexProps {
  documents: HelpFrontmatter[];
}

export const getStaticProps: GetStaticProps<HelpIndexProps> = async () => ({
  props: { documents: loadAllHelpDocuments().map((document) => document.frontmatter) },
});

export default function HelpIndexPage({ documents }: HelpIndexProps) {
  return (
    <>
      <BlogHead
        title="Help centre | ISAFlow Help"
        description={HELP_DESCRIPTION}
        canonical={HELP_URL}
        image={`${SITE_URL}/landing-pitch-dark.png`}
        imageAlt="ISAFlow"
        type="website"
        jsonLd={[breadcrumbJsonLd([
          { name: 'Home', url: `${SITE_URL}/` },
          { name: 'Help', url: HELP_URL },
        ])]}
      />
      <BlogShell band={(
        <>
          <Breadcrumb trail={[{ name: 'Home', href: '/' }, { name: 'Help' }]} />
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-teal-400">ISAFlow Help</p>
          <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">Help centre</h1>
          <p className="mt-5 max-w-2xl text-lg text-white/70">{HELP_DESCRIPTION}</p>
        </>
      )}>
        <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6 lg:px-8" aria-labelledby="help-guides-heading">
          <h2 id="help-guides-heading" className="mb-8 text-2xl font-bold tracking-tight text-slate-900">
            Frequently asked questions and guides
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {documents.map((document) => (
              <article key={document.slug} className="group relative flex flex-col rounded-3xl border border-slate-200 bg-white p-7 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-900/5">
                <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">
                  {document.slug === 'faq' ? 'Frequently asked questions' : 'Guide'}
                </p>
                <h3 className="mt-3 text-xl font-bold tracking-tight text-slate-900">
                  <Link href={`/help/${document.slug}`} className="after:absolute after:inset-0 after:rounded-3xl focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-teal-600 focus-visible:after:ring-offset-2">
                    {document.title}
                  </Link>
                </h3>
                <p className="mt-3 flex-1 leading-relaxed text-slate-700">{document.description}</p>
                <ArrowRight className="mt-6 h-4 w-4 text-teal-700 transition-transform group-hover:translate-x-1" aria-hidden="true" />
              </article>
            ))}
          </div>
        </section>
      </BlogShell>
    </>
  );
}
