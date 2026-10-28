/**
 * /blog/rss.xml — RSS 2.0 feed of published posts (never drafts or scheduled posts,
 * even with preview on). Rendered per request and cached at the edge for an hour.
 */
import type { GetServerSideProps } from 'next';
import { BLOG_REVALIDATE_SECONDS } from '@/lib/blog/constants';
import { loadAllPosts } from '@/lib/blog/content';
import { buildRssXml } from '@/lib/blog/feeds';

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Cache-Control', `public, s-maxage=${BLOG_REVALIDATE_SECONDS}, stale-while-revalidate=60`);
  res.end(buildRssXml(loadAllPosts(), new Date()));
  return { props: {} };
};

export default function BlogRss(): null {
  return null;
}
