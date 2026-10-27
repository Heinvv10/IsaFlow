/**
 * Blog frontmatter schema (zod). Validated at build/ISR time; an invalid file throws a
 * BlogContentError naming the file and the field, which fails `next build`.
 */
import { z } from 'zod';
import { DEFAULT_AUTHOR, SAST_OFFSET } from './constants';

export const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export class BlogContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlogContentError';
  }
}

/** YAML turns an unquoted 2026-11-01 into a Date at UTC midnight; turn it back into what was written. */
function yamlDateToString(v: unknown): unknown {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return v;
  const iso = v.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

/** A date-only value is midnight SAST; a datetime must carry its own offset. */
export function toInstant(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00${SAST_OFFSET}` : value);
}

function isValidIsoDate(value: string): boolean {
  if (!DATE_ONLY.test(value) && !DATE_TIME.test(value)) return false;
  const d = toInstant(value);
  if (Number.isNaN(d.getTime())) return false;
  // Reject calendar overflow such as 2026-02-30, which Date silently rolls forward.
  return !DATE_ONLY.test(value) || new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

const isoDate = z.preprocess(
  yamlDateToString,
  z.string().refine(isValidIsoDate, 'must be an ISO date (YYYY-MM-DD) or ISO datetime with offset'),
);

const sitePath = z.string().regex(/^\/[^\s]*$/, 'must be a site path starting with /');

export const blogFrontmatterSchema = z
  .object({
    title: z.string().trim().min(1),
    slug: z.string().regex(KEBAB_CASE, 'must be lowercase kebab-case (a-z, 0-9, single hyphens)'),
    description: z.string().trim().min(1).max(155, 'must be at most 155 characters'),
    publishDate: isoDate,
    updatedDate: isoDate.optional(),
    author: z.string().trim().min(1).default(DEFAULT_AUTHOR),
    category: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).default([]),
    heroImage: sitePath,
    heroAlt: z.string().trim().min(1),
    ogImage: sitePath.optional(),
    draft: z.boolean().default(false),
    readingTime: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((fm, ctx) => {
    if (fm.updatedDate && toInstant(fm.updatedDate) < toInstant(fm.publishDate)) {
      ctx.addIssue({ code: 'custom', path: ['updatedDate'], message: 'must be on or after publishDate' });
    }
    const prefix = `/blog/${fm.slug}/`;
    for (const key of ['heroImage', 'ogImage'] as const) {
      const v = fm[key];
      if (v && !v.startsWith(prefix)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `must live under ${prefix}` });
      }
    }
  });

export type BlogFrontmatter = z.output<typeof blogFrontmatterSchema>;

/** Validate raw frontmatter; throws BlogContentError listing every bad field with the file path. */
export function parseFrontmatter(raw: unknown, sourcePath: string): BlogFrontmatter {
  const result = blogFrontmatterSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
  throw new BlogContentError(`Invalid blog frontmatter in ${sourcePath}:\n${issues}`);
}
