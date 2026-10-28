/** Display helpers shared by the blog pages and feeds. */
import { toInstant } from './frontmatter';

const LONG_DATE = new Intl.DateTimeFormat('en-ZA', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Johannesburg',
});

/** "27 October 2026" in SAST. */
export function formatBlogDate(value: string): string {
  return LONG_DATE.format(toInstant(value));
}

/** Full ISO 8601 instant, for <time dateTime>, Open Graph and JSON-LD. */
export function isoInstant(value: string): string {
  return toInstant(value).toISOString();
}

/** URL-safe key for a category ("VAT & Tax" -> "vat-tax"). */
export function categoryKey(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
