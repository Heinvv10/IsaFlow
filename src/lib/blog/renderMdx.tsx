/**
 * Compile a post's MDX body to static HTML on the server (getStaticProps / ISR).
 * The browser never evaluates MDX: production CSP has no 'unsafe-eval', and this keeps
 * MDX and chart code out of every client bundle. Content is trusted (repo files, PR-reviewed).
 */
import { evaluate } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import { blogMdxComponents } from '@/components/landing/blog/mdx/mdxComponents';
import { BlogContentError } from './frontmatter';

export async function renderMdxToHtml(body: string, sourcePath: string): Promise<string> {
  try {
    const { default: Content } = await evaluate(body, {
      ...runtime,
      remarkPlugins: [remarkGfm],
      development: false,
    });
    return renderToStaticMarkup(<Content components={blogMdxComponents} />);
  } catch (err) {
    throw new BlogContentError(`Cannot render ${sourcePath}: ${(err as Error).message}`);
  }
}
