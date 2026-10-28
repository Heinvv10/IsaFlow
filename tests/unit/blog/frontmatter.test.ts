import { describe, expect, it } from 'vitest';
import { BlogContentError, parseFrontmatter, toInstant } from '@/lib/blog/frontmatter';
import { validFrontmatter } from './blogFixtures';

const FILE = 'content/blog/my-post/index.mdx';
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...validFrontmatter('my-post'), ...over });
const errorOf = (raw: unknown): string => {
  try {
    parseFrontmatter(raw, FILE);
  } catch (e) {
    expect(e).toBeInstanceOf(BlogContentError);
    return (e as Error).message;
  }
  throw new Error('expected parseFrontmatter to throw');
};

describe('blog frontmatter schema', () => {
  it('accepts a valid post and applies the defaults', () => {
    const fm = parseFrontmatter(valid(), FILE);
    expect(fm.author).toBe('ISAFlow Team');
    expect(fm.tags).toEqual([]);
    expect(fm.draft).toBe(false);
    expect(fm.ogImage).toBeUndefined();
    expect(fm.readingTime).toBeUndefined();
  });

  it('keeps explicit author, tags, draft and readingTime', () => {
    const fm = parseFrontmatter(valid({ author: 'Echo', tags: ['vat'], draft: true, readingTime: 7 }), FILE);
    expect(fm).toMatchObject({ author: 'Echo', tags: ['vat'], draft: true, readingTime: 7 });
  });

  it.each(['title', 'slug', 'description', 'publishDate', 'category', 'heroImage', 'heroAlt'])(
    'fails with the file path and field when %s is missing',
    (field) => {
      const raw = valid();
      delete raw[field];
      const msg = errorOf(raw);
      expect(msg).toContain(FILE);
      expect(msg).toContain(`- ${field}:`);
    },
  );

  it('allows a 155-character description and refuses 156', () => {
    expect(() => parseFrontmatter(valid({ description: 'a'.repeat(155) }), FILE)).not.toThrow();
    expect(errorOf(valid({ description: 'a'.repeat(156) }))).toMatch(/description: must be at most 155 characters/);
  });

  it.each(['27/10/2026', '2026-13-01', '2026-02-30', 'yesterday', '2026-10-27T10:00'])(
    'refuses the bad date %s',
    (publishDate) => {
      expect(errorOf(valid({ publishDate }))).toMatch(/publishDate: must be an ISO date/);
    },
  );

  it('accepts a date-only value and a datetime with offset', () => {
    expect(parseFrontmatter(valid({ publishDate: '2026-10-27' }), FILE).publishDate).toBe('2026-10-27');
    expect(parseFrontmatter(valid({ publishDate: '2026-10-27T09:30:00+02:00' }), FILE).publishDate).toBe(
      '2026-10-27T09:30:00+02:00',
    );
  });

  it('turns a YAML date (unquoted 2026-10-27, parsed to a Date) back into the written date', () => {
    expect(parseFrontmatter(valid({ publishDate: new Date('2026-10-27T00:00:00Z') }), FILE).publishDate).toBe('2026-10-27');
  });

  it('refuses updatedDate before publishDate and accepts the same day or later', () => {
    expect(errorOf(valid({ publishDate: '2026-10-27', updatedDate: '2026-10-26' }))).toMatch(
      /updatedDate: must be on or after publishDate/,
    );
    expect(() => parseFrontmatter(valid({ publishDate: '2026-10-27', updatedDate: '2026-10-27' }), FILE)).not.toThrow();
    expect(() => parseFrontmatter(valid({ publishDate: '2026-10-27', updatedDate: '2026-11-02' }), FILE)).not.toThrow();
  });

  it.each(['My-Post', 'my_post', 'my--post', '-my-post', 'my post'])('refuses the non-kebab slug %s', (slug) => {
    expect(errorOf(valid({ slug }))).toMatch(/slug: must be lowercase kebab-case/);
  });

  it('refuses an unknown key, so a typo cannot silently drop a field', () => {
    expect(errorOf(valid({ publishedDate: '2026-10-27' }))).toMatch(/publishedDate/);
  });

  it('refuses images outside /blog/<slug>/', () => {
    expect(errorOf(valid({ heroImage: '/blog/other-post/hero.webp' }))).toMatch(/heroImage: must live under \/blog\/my-post\//);
    expect(errorOf(valid({ ogImage: 'og.webp' }))).toMatch(/ogImage/);
  });

  it('reads a date-only value as midnight SAST', () => {
    expect(toInstant('2026-10-27').toISOString()).toBe('2026-10-26T22:00:00.000Z');
  });
});
