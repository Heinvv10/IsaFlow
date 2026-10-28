/**
 * Blog content loader. Reads content/blog/<slug>/index.mdx (Echo's convention) and
 * content/blog/<slug>.mdx, validates frontmatter, checks the slug matches the folder or
 * file name and that the referenced images exist under public/. Server-only (fs).
 */
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { DEFAULT_CONTENT_DIR, DEFAULT_PUBLIC_DIR } from './constants';
import { BlogContentError, parseFrontmatter, toInstant, type BlogFrontmatter } from './frontmatter';
import { computeReadingTime } from './readingTime';

export interface BlogPost {
  frontmatter: BlogFrontmatter;
  /** MDX body without frontmatter. */
  body: string;
  /** Path relative to the working directory, for error messages. */
  sourcePath: string;
  readingTimeMinutes: number;
}

export interface LoadOptions {
  /** Defaults to <cwd>/content/blog. */
  contentDir?: string;
  /** Where image paths are checked. Defaults to <cwd>/public; null skips the check. */
  publicDir?: string | null;
}

interface Source {
  slug: string;
  file: string;
}

function rel(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

function discover(contentDir: string): Source[] {
  if (!fs.existsSync(contentDir)) return [];
  const sources: Source[] = [];
  for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const full = path.join(contentDir, entry.name);
    if (entry.isDirectory()) {
      const index = path.join(full, 'index.mdx');
      if (!fs.existsSync(index)) throw new BlogContentError(`${rel(full)} has no index.mdx`);
      sources.push({ slug: entry.name, file: index });
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      sources.push({ slug: entry.name.slice(0, -'.mdx'.length), file: full });
    }
  }
  const seen = new Map<string, string>();
  for (const s of sources) {
    const prior = seen.get(s.slug);
    if (prior) throw new BlogContentError(`Duplicate blog slug "${s.slug}": ${rel(prior)} and ${rel(s.file)}`);
    seen.set(s.slug, s.file);
  }
  return sources;
}

function checkImages(fm: BlogFrontmatter, sourcePath: string, publicDir: string): void {
  for (const key of ['heroImage', 'ogImage'] as const) {
    const src = fm[key];
    if (src && !fs.existsSync(path.join(publicDir, src))) {
      throw new BlogContentError(`Invalid blog frontmatter in ${sourcePath}:\n  - ${key}: file not found: public${src}`);
    }
  }
}

export function loadPostFile(file: string, expectedSlug: string, publicDir: string | null): BlogPost {
  const sourcePath = rel(file);
  let parsed: matter.GrayMatterFile<string>;
  try {
    // Empty options object: gray-matter caches by content otherwise, and returns a shared object.
    parsed = matter(fs.readFileSync(file, 'utf8'), {});
  } catch (err) {
    throw new BlogContentError(`Cannot parse frontmatter in ${sourcePath}: ${(err as Error).message}`);
  }
  const frontmatter = parseFrontmatter(parsed.data, sourcePath);
  if (frontmatter.slug !== expectedSlug) {
    throw new BlogContentError(
      `Invalid blog frontmatter in ${sourcePath}:\n  - slug: "${frontmatter.slug}" must match the folder/file name "${expectedSlug}"`,
    );
  }
  if (publicDir) checkImages(frontmatter, sourcePath, publicDir);
  return {
    frontmatter,
    body: parsed.content,
    sourcePath,
    readingTimeMinutes: computeReadingTime(parsed.content, frontmatter.readingTime),
  };
}

/** Every post on disk (drafts included), newest publishDate first. Throws on any invalid file. */
export function loadAllPosts(options: LoadOptions = {}): BlogPost[] {
  const contentDir = options.contentDir ?? DEFAULT_CONTENT_DIR();
  const publicDir = options.publicDir === undefined ? DEFAULT_PUBLIC_DIR() : options.publicDir;
  return discover(contentDir)
    .map((s) => loadPostFile(s.file, s.slug, publicDir))
    .sort(
      (a, b) =>
        toInstant(b.frontmatter.publishDate).getTime() - toInstant(a.frontmatter.publishDate).getTime() ||
        a.frontmatter.slug.localeCompare(b.frontmatter.slug),
    );
}

export function findPost(posts: BlogPost[], slug: string): BlogPost | undefined {
  return posts.find((p) => p.frontmatter.slug === slug);
}
