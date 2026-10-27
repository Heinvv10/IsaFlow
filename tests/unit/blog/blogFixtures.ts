/**
 * Fixture blog trees for the blog tests: a content dir and a public dir in a fresh temp
 * folder per call, so no test reads or depends on the real content/blog.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface FixturePost {
  slug: string;
  /** Frontmatter fields; merged over a valid default. Set a key to undefined to drop it. */
  fm?: Record<string, unknown>;
  body?: string;
  /** 'folder' writes <slug>/index.mdx (default); 'flat' writes <slug>.mdx. */
  layout?: 'folder' | 'flat';
  /** Write hero.webp/og.webp under public/blog/<slug>/ (default true). */
  images?: boolean;
}

export function validFrontmatter(slug: string): Record<string, unknown> {
  return {
    title: `Post ${slug}`,
    slug,
    description: `About ${slug}.`,
    publishDate: '2026-01-15',
    category: 'VAT & Tax',
    heroImage: `/blog/${slug}/hero.webp`,
    heroAlt: `Hero for ${slug}`,
  };
}

function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

export function toMdx(fm: Record<string, unknown>, body: string): string {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
}

export function makeBlogFixture(posts: FixturePost[]): { root: string; contentDir: string; publicDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isaflow-blog-'));
  const contentDir = path.join(root, 'content', 'blog');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(contentDir, { recursive: true });
  for (const p of posts) {
    const fm = { ...validFrontmatter(p.slug), ...p.fm };
    const mdx = toMdx(fm, p.body ?? 'Hello **world**.');
    if (p.layout === 'flat') {
      fs.writeFileSync(path.join(contentDir, `${p.slug}.mdx`), mdx);
    } else {
      fs.mkdirSync(path.join(contentDir, p.slug), { recursive: true });
      fs.writeFileSync(path.join(contentDir, p.slug, 'index.mdx'), mdx);
    }
    if (p.images !== false) {
      const dir = path.join(publicDir, 'blog', p.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'hero.webp'), '');
      fs.writeFileSync(path.join(dir, 'og.webp'), '');
    }
  }
  return { root, contentDir, publicDir };
}

export function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
