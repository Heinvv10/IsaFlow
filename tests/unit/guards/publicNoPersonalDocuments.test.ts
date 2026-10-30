/**
 * Everything under public/ is served by Next.js to anyone, with no login.
 * Real Blitz Fibre payroll documents (payslips, pay register, EMP201, UIF
 * submission) sat in public/Payroll Docs/ from 2026-04-12 until 2026-10-05
 * and were downloadable from production. This guard fails the build if any
 * document file, or anything named like payroll or tax paperwork, is put back.
 * It walks the directory on disk (what deploy.sh copies), not the git index.
 *
 * One narrow exception to the NAME check only: a blog post's images. The blog
 * requires them under public/blog/<slug>/ (src/lib/blog/frontmatter.ts), and
 * tax guides have slugs like emp201-due-dates-penalties. Exempt are the folder
 * public/blog/<slug> and image files directly in it, and only where <slug> is a
 * post that exists in content/blog. The document-file check still covers them.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'public');
const BLOG_CONTENT_DIR = join(process.cwd(), 'content', 'blog');
const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|csv|zip)$/i;
const SENSITIVE_NAME = /payslip|payroll|pay[-_ ]?register|emp20|emp501|irp5|it3|uif|remuneration|salar|leave|bank[-_ ]?statement|id[-_ ]?doc/i;
const BLOG_IMAGE_EXT = /\.(svg|webp|png|jpe?g|avif)$/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? [full, ...walk(full)] : [full];
  });
}

const blogSlugs = new Set(
  existsSync(BLOG_CONTENT_DIR)
    ? readdirSync(BLOG_CONTENT_DIR).filter((name) => existsSync(join(BLOG_CONTENT_DIR, name, 'index.mdx')))
    : [],
);

/** public/blog/<slug> or public/blog/<slug>/<image>, for a slug that is a real post. */
function isBlogPostImagePath(p: string, slugs: ReadonlySet<string>): boolean {
  const parts = p.split(/[\\/]/);
  if (parts[0] !== 'blog' || !slugs.has(parts[1] ?? '')) return false;
  if (parts.length === 2) return true;
  return parts.length === 3 && BLOG_IMAGE_EXT.test(parts[2]) && !SENSITIVE_NAME.test(parts[2]);
}

describe('public/ serves no personal or payroll documents', () => {
  const paths = walk(PUBLIC_DIR).map((p) => relative(PUBLIC_DIR, p));

  it('walked the real public directory', () => {
    expect(paths.length).toBeGreaterThan(5);
  });

  it('holds no document files', () => {
    expect(paths.filter((p) => DOCUMENT_EXT.test(p))).toEqual([]);
  });

  it('holds nothing named like payroll or tax paperwork', () => {
    expect(paths.filter((p) => SENSITIVE_NAME.test(p) && !isBlogPostImagePath(p, blogSlugs))).toEqual([]);
  });

  it('exempts only images of real blog posts', () => {
    const slugs = new Set(['emp201-due-dates-penalties']);
    expect(isBlogPostImagePath('blog/emp201-due-dates-penalties', slugs)).toBe(true);
    expect(isBlogPostImagePath('blog/emp201-due-dates-penalties/chart-1.svg', slugs)).toBe(true);
    expect(isBlogPostImagePath('blog/emp201-due-dates-penalties/hero.webp', slugs)).toBe(true);
    // Not a post in content/blog.
    expect(isBlogPostImagePath('blog/emp201-march', slugs)).toBe(false);
    expect(isBlogPostImagePath('blog/emp201-march/hero.webp', slugs)).toBe(false);
    // Not an image, nested, or itself named like paperwork.
    expect(isBlogPostImagePath('blog/emp201-due-dates-penalties/notes.txt', slugs)).toBe(false);
    expect(isBlogPostImagePath('blog/emp201-due-dates-penalties/sub/hero.webp', slugs)).toBe(false);
    expect(isBlogPostImagePath('blog/emp201-due-dates-penalties/payslip-june.webp', slugs)).toBe(false);
    // Outside public/blog.
    expect(isBlogPostImagePath('Payroll Docs/emp201.webp', slugs)).toBe(false);
  });
});
