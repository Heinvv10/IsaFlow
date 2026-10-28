import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPost, loadAllPosts } from '@/lib/blog/content';
import { makeBlogFixture, removeFixture, type FixturePost } from './blogFixtures';

const roots: string[] = [];
const fixture = (posts: FixturePost[]) => {
  const f = makeBlogFixture(posts);
  roots.push(f.root);
  return f;
};
afterEach(() => roots.splice(0).forEach(removeFixture));

describe('blog content loader', () => {
  it('reads content/blog/<slug>/index.mdx and content/blog/<slug>.mdx', () => {
    const f = fixture([{ slug: 'folder-post', body: 'Folder body' }, { slug: 'flat-post', layout: 'flat', body: 'Flat body' }]);
    const posts = loadAllPosts({ contentDir: f.contentDir, publicDir: f.publicDir });
    expect(posts.map((p) => p.frontmatter.slug).sort()).toEqual(['flat-post', 'folder-post']);
    expect(findPost(posts, 'folder-post')?.body.trim()).toBe('Folder body');
    expect(findPost(posts, 'flat-post')?.body.trim()).toBe('Flat body');
    expect(findPost(posts, 'folder-post')?.sourcePath).toMatch(/folder-post[/\\]index\.mdx$/);
  });

  it('sorts newest publishDate first', () => {
    const f = fixture([
      { slug: 'old', fm: { publishDate: '2026-01-01' } },
      { slug: 'new', fm: { publishDate: '2026-06-01' } },
      { slug: 'mid', fm: { publishDate: '2026-03-01' } },
    ]);
    expect(loadAllPosts({ contentDir: f.contentDir, publicDir: f.publicDir }).map((p) => p.frontmatter.slug)).toEqual([
      'new', 'mid', 'old',
    ]);
  });

  it('fails when the frontmatter slug does not match the folder name', () => {
    const f = fixture([{ slug: 'right-name', fm: { slug: 'wrong-name', heroImage: '/blog/wrong-name/hero.webp' } }]);
    expect(() => loadAllPosts({ contentDir: f.contentDir, publicDir: null })).toThrow(
      /right-name[/\\]index\.mdx[\s\S]*slug: "wrong-name" must match the folder\/file name "right-name"/,
    );
  });

  it('fails loudly naming the file and field on invalid frontmatter', () => {
    const f = fixture([{ slug: 'bad-post', fm: { description: 'x'.repeat(200) } }]);
    expect(() => loadAllPosts({ contentDir: f.contentDir, publicDir: f.publicDir })).toThrow(
      /bad-post[/\\]index\.mdx[\s\S]*description: must be at most 155 characters/,
    );
  });

  it('fails when a referenced image is missing from public/', () => {
    const f = fixture([{ slug: 'no-images', images: false }]);
    expect(() => loadAllPosts({ contentDir: f.contentDir, publicDir: f.publicDir })).toThrow(
      /heroImage: file not found: public\/blog\/no-images\/hero\.webp/,
    );
  });

  it('fails on a folder without index.mdx and on a duplicate slug', () => {
    const empty = fixture([]);
    fs.mkdirSync(path.join(empty.contentDir, 'empty-folder'));
    expect(() => loadAllPosts({ contentDir: empty.contentDir, publicDir: null })).toThrow(/empty-folder has no index\.mdx/);

    const dup = fixture([{ slug: 'twice' }, { slug: 'twice', layout: 'flat' }]);
    expect(() => loadAllPosts({ contentDir: dup.contentDir, publicDir: dup.publicDir })).toThrow(/Duplicate blog slug "twice"/);
  });

  it('returns no posts when the content folder does not exist', () => {
    expect(loadAllPosts({ contentDir: '/nonexistent/isaflow/blog', publicDir: null })).toEqual([]);
  });

  it('computes reading time unless the frontmatter overrides it', () => {
    const long = Array.from({ length: 500 }, () => 'word').join(' ');
    const f = fixture([{ slug: 'computed', body: long }, { slug: 'overridden', body: long, fm: { readingTime: 9 } }]);
    const posts = loadAllPosts({ contentDir: f.contentDir, publicDir: f.publicDir });
    expect(findPost(posts, 'computed')?.readingTimeMinutes).toBe(3);
    expect(findPost(posts, 'overridden')?.readingTimeMinutes).toBe(9);
  });

  it('the real content/blog validates, and its only post is the draft placeholder', () => {
    const posts = loadAllPosts();
    expect(posts.length).toBeGreaterThan(0);
    const placeholder = findPost(posts, 'placeholder-component-showcase');
    expect(placeholder?.frontmatter.draft).toBe(true);
    expect(placeholder?.frontmatter.title).toMatch(/^PLACEHOLDER -/);
  });
});
