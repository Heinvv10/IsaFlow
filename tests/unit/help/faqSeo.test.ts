import { describe, expect, it } from 'vitest';
import { findHelpDocument, loadAllHelpDocuments } from '@/lib/help/content';
import { extractFaqItems, faqPageJsonLd } from '@/lib/help/seo';

describe('help FAQ structured data', () => {
  it('includes every level-three question with a plain-text answer', () => {
    const faq = findHelpDocument(loadAllHelpDocuments(), 'faq');
    expect(faq).toBeDefined();
    const body = faq?.body ?? '';
    const headingCount = body.match(/^### /gm)?.length ?? 0;
    const items = extractFaqItems(body);
    const jsonLd = faqPageJsonLd(items);

    expect(items).toHaveLength(headingCount);
    expect(jsonLd.mainEntity).toHaveLength(headingCount);
    expect(items.map((item) => item.question)).toContain('How do I sign up?');
    expect(items.find((item) => item.question === 'Can one client company ever see another client\'s data?')?.answer)
      .toContain('Something looks wrong?');
    expect(items.every((item) => !/[\[\]*`]/.test(item.answer))).toBe(true);
  });
});
