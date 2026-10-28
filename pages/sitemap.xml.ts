/**
 * /sitemap.xml for the marketing host: the public marketing pages, /blog and every
 * published post (lastmod = updatedDate || publishDate). Drafts and scheduled posts are
 * never listed. On app.isaflow.co.za middleware redirects this path to isaflow.co.za.
 */
import type { GetServerSideProps } from 'next';
import { BLOG_REVALIDATE_SECONDS } from '@/lib/blog/constants';
import { loadAllPosts } from '@/lib/blog/content';
import { buildSitemapXml } from '@/lib/blog/feeds';

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', `public, s-maxage=${BLOG_REVALIDATE_SECONDS}, stale-while-revalidate=60`);
  res.end(buildSitemapXml(loadAllPosts(), new Date()));
  return { props: {} };
};

export default function Sitemap(): null {
  return null;
}
