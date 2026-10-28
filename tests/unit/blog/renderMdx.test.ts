import { describe, expect, it } from 'vitest';
import { renderMdxToHtml } from '@/lib/blog/renderMdx';

const render = (mdx: string): Promise<string> => renderMdxToHtml(mdx, 'content/blog/test/index.mdx');

describe('blog MDX rendering', () => {
  it('compiles a GFM table to a <table> with alignment, inside the scroll wrapper', async () => {
    const html = await render(['| Item | Amount |', '| :--- | ---: |', '| A | R 10.00 |'].join('\n'));
    expect(html).toMatch(/<div class="blog-table[^"]*overflow-x-auto[^"]*"[^>]*><table/);
    expect(html).toContain('<thead>');
    expect(html).toMatch(/<td style="text-align:right">R 10.00<\/td>/);
    expect(html).toMatch(/<th style="text-align:left">Item<\/th>/);
  });

  it('supports the rest of GFM: strikethrough, task lists, autolinks', async () => {
    const html = await render('~~old~~\n\n- [x] done\n- [ ] todo\n\nSee https://example.com/page');
    expect(html).toContain('<del>old</del>');
    expect(html).toMatch(/<ul class="contains-task-list">/);
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/>/);
    expect(html).toMatch(/<a href="https:\/\/example.com\/page" target="_blank" rel="noopener noreferrer">/);
  });

  it('keeps own-site links in the same tab', async () => {
    const html = await render('[pricing](https://isaflow.co.za/pricing) and [x](https://isaflow.co.za.evil.example/)');
    expect(html).toContain('<a href="https://isaflow.co.za/pricing">pricing</a>');
    expect(html).toMatch(/isaflow\.co\.za\.evil\.example\/" target="_blank"/);
  });

  it('renders Chart, Callout and Screenshot to static HTML', async () => {
    const html = await render(
      [
        '<Chart type="bar" title="T" source="S" data={[{ label: "a", value: 1 }, { label: "b", value: 2 }]} />',
        '<Callout type="warning">Careful</Callout>',
        '<Screenshot src="/blog/test/shot.webp" alt="A shot" caption="Cap" />',
      ].join('\n\n'),
    );
    expect(html).toContain('<svg');
    expect(html).toContain('Source: S');
    expect(html).toContain('Warning');
    expect(html).toContain('Careful');
    expect(html).toMatch(/<img[^>]+alt="A shot"/);
    expect(html).toContain('/_next/image?url=%2Fblog%2Ftest%2Fshot.webp');
    expect(html).toContain('Cap');
  });

  it('fails naming the file on an invalid chart or bad MDX', async () => {
    await expect(render('<Chart type="donut" title="T" source="S" data={[{ label: "a", value: 1 }]} />')).rejects.toThrow(
      /content\/blog\/test\/index\.mdx[\s\S]*Invalid <Chart> "T": type/,
    );
    await expect(render('<Callout>unclosed')).rejects.toThrow(/Cannot render content\/blog\/test\/index\.mdx/);
  });
});

describe('every real post in content/blog renders', () => {
  it('compiles each post (charts and components validated) without throwing', async () => {
    const { loadAllPosts } = await import('@/lib/blog/content');
    const posts = loadAllPosts();
    for (const p of posts) {
      const html = await renderMdxToHtml(p.body, p.sourcePath);
      expect(html.length, p.sourcePath).toBeGreaterThan(0);
    }
    const placeholder = posts.find((p) => p.frontmatter.slug === 'placeholder-component-showcase');
    expect(placeholder).toBeDefined();
    const html = await renderMdxToHtml(placeholder?.body ?? '', 'placeholder');
    expect(html.match(/<svg viewBox="0 0 /g)?.length).toBe(3);
    expect(html).toContain('<table');
  });
});
