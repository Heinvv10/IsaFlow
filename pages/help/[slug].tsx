import Link from 'next/link';
import type { GetStaticPaths, GetStaticProps } from 'next';
import { ArticleBody } from '@/components/landing/blog/ArticleBody';
import { BlogHead } from '@/components/landing/blog/BlogHead';
import { BlogShell, Breadcrumb } from '@/components/landing/blog/BlogShell';
import { SITE_URL } from '@/lib/blog/constants';
import { breadcrumbJsonLd } from '@/lib/blog/seo';
import { HELP_URL } from '@/lib/help/constants';
import { findHelpDocument, loadAllHelpDocuments, type HelpFrontmatter } from '@/lib/help/content';
import { extractFaqItems, faqPageJsonLd } from '@/lib/help/seo';
import { renderMdxToHtml } from '@/lib/blog/renderMdx';

interface HelpPageProps {
  document: HelpFrontmatter;
  html: string;
  faqJsonLd: ReturnType<typeof faqPageJsonLd> | null;
}

export const getStaticPaths: GetStaticPaths = async () => ({
  paths: loadAllHelpDocuments().map((document) => ({ params: { slug: document.frontmatter.slug } })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<HelpPageProps, { slug: string }> = async ({ params }) => {
  const found = params ? findHelpDocument(loadAllHelpDocuments(), params.slug) : undefined;
  if (!found) return { notFound: true };
  return {
    props: {
      document: found.frontmatter,
      html: await renderMdxToHtml(found.body, found.sourcePath),
      faqJsonLd: found.frontmatter.slug === 'faq' ? faqPageJsonLd(extractFaqItems(found.body)) : null,
    },
  };
};

export default function HelpPage({ document, html, faqJsonLd }: HelpPageProps) {
  const canonical = `${HELP_URL}/${document.slug}`;
  const structuredData = [
    breadcrumbJsonLd([
      { name: 'Home', url: `${SITE_URL}/` },
      { name: 'Help', url: HELP_URL },
      { name: document.title, url: canonical },
    ]),
    ...(faqJsonLd ? [faqJsonLd] : []),
  ];

  return (
    <>
      <BlogHead
        title={`${document.title} | ISAFlow Help`}
        description={document.description}
        canonical={canonical}
        image={`${SITE_URL}/landing-pitch-dark.png`}
        imageAlt="ISAFlow"
        type="website"
        jsonLd={structuredData}
      />
      <BlogShell band={(
        <div className="max-w-3xl">
          <Breadcrumb trail={[
            { name: 'Home', href: '/' },
            { name: 'Help', href: '/help' },
            { name: document.title },
          ]} />
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">{document.title}</h1>
          <p className="mt-5 text-lg text-white/70">{document.description}</p>
          <p className="mt-6 text-sm text-white/70">
            Updated <time dateTime={document.updated}>{document.updated}</time>
          </p>
        </div>
      )}>
        <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6 lg:px-8">
          <ArticleBody html={html} />
          <p className="mt-14 border-t border-slate-200 pt-8 text-sm font-semibold">
            <Link href="/help" className="text-teal-700 underline decoration-teal-300 underline-offset-4 hover:decoration-teal-600">
              Back to Help
            </Link>
          </p>
        </article>
      </BlogShell>
    </>
  );
}
