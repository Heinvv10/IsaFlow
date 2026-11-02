import { describe, expect, it } from 'vitest';
import { findHelpDocument, loadAllHelpDocuments } from '@/lib/help/content';
import { renderMdxToHtml } from '@/lib/blog/renderMdx';

const EXPECTED_SLUGS = [
  'faq',
  'getting-started-for-a-bureau',
  'migrating-a-client-from-sage',
  'running-payroll',
  'preparing-sars-returns-for-efiling',
  'something-looks-wrong',
  'using-isaflow-on-a-phone',
];

describe('help content', () => {
  it('loads every document in frontmatter order', () => {
    const documents = loadAllHelpDocuments();
    expect(documents.map((document) => document.frontmatter.slug)).toEqual(EXPECTED_SLUGS);
    expect(findHelpDocument(documents, 'faq')?.frontmatter.order).toBe(0);
  });

  it('renders every document body', async () => {
    for (const document of loadAllHelpDocuments()) {
      const html = await renderMdxToHtml(document.body, document.sourcePath);
      expect(html.length, document.sourcePath).toBeGreaterThan(0);
    }
  });

  it('contains no unresolved placeholders or em dashes', () => {
    for (const document of loadAllHelpDocuments()) {
      expect(document.body, document.sourcePath).not.toMatch(/\[(?:TRIAL|SUPPORT|CONFIRM)/);
      expect(document.body, document.sourcePath).not.toContain('\u2014');
    }
  });

  it('has a document for every internal help link', () => {
    const documents = loadAllHelpDocuments();
    const slugs = new Set(documents.map((document) => document.frontmatter.slug));
    for (const document of documents) {
      const links = [...document.body.matchAll(/\]\(\/help\/([a-z0-9-]+)\)/g)];
      for (const link of links) expect(slugs.has(link[1] ?? ''), link[0]).toBe(true);
    }
  });
});
