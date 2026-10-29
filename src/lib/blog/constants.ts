/**
 * Blog constants. SITE_URL is the single canonical origin for every blog URL
 * (canonical, Open Graph, JSON-LD, sitemap, RSS) regardless of the host serving the page.
 */
import path from 'path';

export const SITE_URL = 'https://isaflow.co.za';
export const BLOG_PATH = '/blog';
export const BLOG_URL = `${SITE_URL}${BLOG_PATH}`;
export const BLOG_RSS_PATH = `${BLOG_PATH}/rss.xml`;
export const BLOG_TITLE = 'ISAFlow Blog';
export const BLOG_DESCRIPTION =
  'Practical guides on accounting, VAT, payroll and running a South African business, from the ISAFlow team.';
export const DEFAULT_AUTHOR = 'ISAFlow Team';
export const PUBLISHER_NAME = 'ISAFlow';
export const PUBLISHER_LOGO = `${SITE_URL}/logo.png`;

/** ISR window for blog pages: a scheduled post goes live within this many seconds of its publishDate. */
export const BLOG_REVALIDATE_SECONDS = 3600;

/** Date-only publish dates are read as midnight in South Africa (SAST, UTC+2, no DST). */
export const SAST_OFFSET = '+02:00';

export const HERO_SIZE = { width: 1600, height: 900 } as const;
export const OG_SIZE = { width: 1200, height: 630 } as const;

export const DEFAULT_CONTENT_DIR = (): string => path.join(process.cwd(), 'content', 'blog');
export const DEFAULT_PUBLIC_DIR = (): string => path.join(process.cwd(), 'public');
