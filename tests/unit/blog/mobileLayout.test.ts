import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Breadcrumb } from '@/components/landing/blog/BlogShell';
import { renderMdxToHtml } from '@/lib/blog/renderMdx';

const render = (mdx: string): Promise<string> => renderMdxToHtml(mdx, 'content/blog/test/index.mdx');

describe('blog tables on narrow screens', () => {
  it('sizes the table to its content inside a keyboard-scrollable .blog-table region', async () => {
    const html = await render(['| Submission | Per year |', '| --- | ---: |', '| VAT201 | 6 |'].join('\n'));
    expect(html).not.toContain('min-w-[32rem]');
    expect(html).toMatch(/<div class="blog-table[^"]*" role="region" aria-label="Table" tabindex="0"><table class="w-full /);
  });
});

describe('Markdown images', () => {
  it('links a plain image to its full-size file in a new tab, with an accessible label', async () => {
    const html = await render('Intro\n\n![Wide VAT chart](/blog/test/wide.webp)');
    const link = html.match(/<a [^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(link).toContain('href="/blog/test/wide.webp"');
    expect(link).toContain('target="_blank"');
    expect(link).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/);
    expect(link).toContain('aria-label="Open full-size image: Wide VAT chart (opens in new tab)"');
    expect(link).toMatch(/<img src="\/blog\/test\/wide.webp" alt="Wide VAT chart" loading="lazy" decoding="async"/);
    expect(link).toMatch(/<span aria-hidden="true" class="[^"]*sm:hidden[^"]*">/);
  });

  it('does not wrap an image the author already linked, nor Chart or Screenshot', async () => {
    const linked = await render('[![Logo](/blog/test/logo.webp)](https://example.com/)');
    expect(linked.match(/<a /g)).toHaveLength(1);
    expect(linked).toMatch(/<a href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer"><img src="\/blog\/test\/logo.webp"/);
    expect(linked).not.toContain('Open full-size image');

    const components = await render(
      [
        '<Chart type="bar" title="T" source="S" data={[{ label: "a", value: 1 }]} />',
        '<Screenshot src="/blog/test/shot.webp" alt="A shot" />',
        '<Figure caption="Cap"><img src="/blog/test/raw.webp" alt="Raw" /></Figure>',
      ].join('\n\n'),
    );
    expect(components).not.toContain('<a ');
    expect(components).not.toContain('Open full-size image');
  });
});

describe('Breadcrumb', () => {
  it('keeps one line and truncates the current page', () => {
    const html = renderToStaticMarkup(
      createElement(Breadcrumb, { trail: [{ name: 'Home', href: '/' }, { name: 'Blog', href: '/blog' }, { name: 'A very long post title' }] }),
    );
    expect(html).toMatch(/<ol class="[^"]*\bwhitespace-nowrap\b[^"]*">/);
    expect(html).toMatch(/<span aria-current="page" class="[^"]*\btruncate\b[^"]*">A very long post title<\/span>/);
    expect(html).toMatch(/<li class="[^"]*\bmin-w-0\b[^"]*">(?:(?!<li).)*aria-current="page"/);
  });
});
