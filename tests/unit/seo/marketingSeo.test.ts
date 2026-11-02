import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FAQ_ITEMS } from '@/components/landing/landingData';
import { COMPARE_ENTRIES } from '@/lib/compare/compareData';
import { buildSitemapXml } from '@/lib/blog/feeds';
import { buildFaqPage, jsonLdScriptText } from '@/lib/seo/faqSchema';
import { isMarketingOnlyPath } from '../../../middleware';

const pub = (f: string) => readFileSync(path.join(process.cwd(), 'public', f), 'utf8');

describe('FAQPage schema', () => {
  it('mirrors the visible items one to one', () => {
    const faq = buildFaqPage('x', FAQ_ITEMS) as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(faq.mainEntity).toHaveLength(FAQ_ITEMS.length);
    FAQ_ITEMS.forEach((item, i) => {
      expect(faq.mainEntity[i]?.name).toBe(item.q);
      expect(faq.mainEntity[i]?.acceptedAnswer.text).toBe(item.a);
    });
    expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(8);
    expect(FAQ_ITEMS.length).toBeLessThanOrEqual(10);
  });

  it('escapes "<" so text cannot close the script tag', () => {
    expect(jsonLdScriptText({ a: '</script>' })).not.toContain('</script>');
    expect(JSON.parse(jsonLdScriptText({ a: '</script>' }))).toEqual({ a: '</script>' });
  });
});

describe('compare pages', () => {
  it('cover sage, xero and quickbooks and appear in the sitemap', () => {
    expect(COMPARE_ENTRIES.map((e) => e.slug)).toEqual(['sage', 'xero', 'quickbooks']);
    const xml = buildSitemapXml([], new Date());
    for (const e of COMPARE_ENTRIES) expect(xml).toContain(`<loc>https://isaflow.co.za/compare/${e.slug}</loc>`);
  });

  it('quote no competitor prices', () => {
    for (const e of COMPARE_ENTRIES) {
      expect(JSON.stringify(e)).not.toMatch(/R\s?\d|\$\s?\d/);
      expect(e.faq.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('are marketing-host only', () => {
    expect(isMarketingOnlyPath('/compare/sage')).toBe(true);
    expect(isMarketingOnlyPath('/compared')).toBe(false);
  });
});

describe('robots.txt and llms.txt', () => {
  const robots = pub('robots.txt');
  it('allows the AI crawlers, blocks app paths, lists the sitemap', () => {
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot']) {
      expect(robots).toMatch(new RegExp(`User-agent: ${bot}\\nAllow: /\\n`));
    }
    expect(robots).toContain('Disallow: /accounting/');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Sitemap: https://isaflow.co.za/sitemap.xml');
    expect(robots).not.toMatch(/^Disallow: \/$/m);
  });

  it('llms.txt follows the llmstxt.org shape and links the new pages', () => {
    const llms = pub('llms.txt');
    expect(llms.startsWith('# ISAFlow\n')).toBe(true);
    expect(llms).toMatch(/^> /m);
    expect(llms).toContain('https://isaflow.co.za/compare/sage');
  });
});
