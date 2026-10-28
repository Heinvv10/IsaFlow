/**
 * <head> for blog pages: title, description, canonical on https://isaflow.co.za, Open Graph,
 * Twitter card, RSS alternate and JSON-LD. Preview-only pages (draft/scheduled) are noindex.
 */
import Head from 'next/head';
import { BLOG_RSS_PATH, BLOG_TITLE, OG_SIZE, SITE_URL } from '@/lib/blog/constants';
import { jsonLdString } from '@/lib/blog/seo';

export interface ArticleMeta {
  publishedTime: string;
  modifiedTime: string;
  section: string;
  tags: string[];
}

interface Props {
  title: string;
  description: string;
  /** Absolute canonical URL. */
  canonical: string;
  /** Absolute image URL. */
  image: string;
  imageAlt: string;
  type: 'website' | 'article';
  article?: ArticleMeta;
  jsonLd: Record<string, unknown>[];
  noindex?: boolean;
}

export function BlogHead({ title, description, canonical, image, imageAlt, type, article, jsonLd, noindex }: Props) {
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/favicon.ico" />
      <link rel="canonical" href={canonical} />
      <link rel="alternate" type="application/rss+xml" title={BLOG_TITLE} href={`${SITE_URL}${BLOG_RSS_PATH}`} />
      {noindex && <meta name="robots" content="noindex, nofollow" />}

      <meta property="og:site_name" content="ISAFlow" />
      <meta property="og:locale" content="en_ZA" />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={image} />
      <meta property="og:image:alt" content={imageAlt} />
      {type === 'article' && (
        <>
          <meta property="og:image:width" content={String(OG_SIZE.width)} />
          <meta property="og:image:height" content={String(OG_SIZE.height)} />
        </>
      )}
      {article && (
        <>
          <meta property="article:published_time" content={article.publishedTime} />
          <meta property="article:modified_time" content={article.modifiedTime} />
          <meta property="article:section" content={article.section} />
          {article.tags.map((t) => (
            <meta key={t} property="article:tag" content={t} />
          ))}
        </>
      )}

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
      <meta name="twitter:image:alt" content={imageAlt} />

      {jsonLd.map((data, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />
      ))}
    </Head>
  );
}
