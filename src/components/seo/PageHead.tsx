/**
 * <head> for public marketing pages: title, description, canonical on the one
 * marketing origin, Open Graph and Twitter card.
 */
import Head from 'next/head';
import { SITE_URL } from '@/lib/blog/constants';

export const DEFAULT_OG_IMAGE = `${SITE_URL}/logo.png`;

interface Props {
  title: string;
  description: string;
  /** Path on the marketing origin, e.g. "/pricing". */
  path: string;
  type?: 'website' | 'article';
}

export function PageHead({ title, description, path, type = 'website' }: Props) {
  const canonical = path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`;
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/favicon.ico" />
      <link rel="canonical" href={canonical} />
      <meta property="og:site_name" content="ISAFlow" />
      <meta property="og:locale" content="en_ZA" />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={DEFAULT_OG_IMAGE} />
      <meta property="og:image:alt" content="ISAFlow cloud accounting software for South Africa" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={DEFAULT_OG_IMAGE} />
    </Head>
  );
}
