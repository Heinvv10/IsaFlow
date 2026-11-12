import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FAQ_ITEMS } from '@/components/landing/landingData';
import { COMPARE_ENTRIES } from '@/lib/compare/compareData';
import { buildSitemapXml } from '@/lib/blog/feeds';
import { buildFaqPage, jsonLdScriptText } from '@/lib/seo/faqSchema';
import { NextRequest } from 'next/server';
import { isMarketingOnlyPath, middleware } from '../../../middleware';

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
  it('cover sage, xero, quickbooks, simplepay and payspace and appear in the sitemap', () => {
    expect(COMPARE_ENTRIES.map((e) => e.slug)).toEqual(['sage', 'xero', 'quickbooks', 'simplepay', 'payspace']);
    const xml = buildSitemapXml([], new Date());
    for (const e of COMPARE_ENTRIES) expect(xml).toContain(`<loc>https://isaflow.co.za/compare/${e.slug}</loc>`);
  });

  it('quote no competitor prices', () => {
    for (const e of COMPARE_ENTRIES) {
      expect(JSON.stringify(e)).not.toMatch(/R\s?\d|\$\s?\d/);
      expect(e.faq.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('are marketing-host only: the app host 308s to isaflow.co.za', async () => {
    expect(isMarketingOnlyPath('/compared')).toBe(false);
    const host = 'app.isaflow.co.za';
    const res = await middleware(new NextRequest('https://app.isaflow.co.za/compare/sage?x=1', { headers: { host } }));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://isaflow.co.za/compare/sage?x=1');
    const own = await middleware(new NextRequest('https://isaflow.co.za/compare/sage', { headers: { host: 'isaflow.co.za' } }));
    expect(own.headers.get('location')).toBeNull();
  });
});

describe('robots.txt and llms.txt', () => {
  const robots = pub('robots.txt');
  const groups = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    let agents: string[] = [];
    let lastWasAgent = false;
    for (const raw of robots.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [k, ...rest] = line.split(':');
      const key = (k ?? '').toLowerCase();
      const val = rest.join(':').trim();
      if (key === 'user-agent') {
        if (!lastWasAgent) agents = [];
        agents.push(val);
        out.set(val, []);
        lastWasAgent = true;
      } else {
        lastWasAgent = false;
        if (key === 'disallow') for (const a of agents) out.get(a)?.push(val);
      }
    }
    return out;
  };

  it('every named group allows crawling and carries the full Disallow list of the * group', () => {
    const g = groups();
    const star = g.get('*') ?? [];
    expect(star).toEqual(expect.arrayContaining(['/accounting/', '/payroll/', '/api/', '/auth/', '/login']));
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot']) {
      expect(g.has(bot), bot).toBe(true);
    }
    for (const [agent, disallows] of g) {
      expect([...disallows].sort(), agent).toEqual([...star].sort());
      expect(disallows, agent).not.toContain('/');
    }
    expect(robots).toContain('Sitemap: https://isaflow.co.za/sitemap.xml');
  });

  it('llms.txt follows the llmstxt.org shape and links the new pages', () => {
    const llms = pub('llms.txt');
    expect(llms.startsWith('# IsaFlow\n')).toBe(true);
    expect(llms).toMatch(/^> /m);
    expect(llms).toContain('https://isaflow.co.za/compare/sage');
    for (const p of ['/features', '/about', '/compare/simplepay', '/compare/payspace']) {
      expect(llms).toContain(`https://isaflow.co.za${p}`);
    }
    expect(llms).not.toMatch(/ABSA/);
  });

  it('robots.txt does not block the new marketing pages', () => {
    for (const disallows of groups().values()) {
      for (const d of disallows) {
        for (const p of ['/features', '/about', '/compare/simplepay']) expect(p.startsWith(d), `${d} blocks ${p}`).toBe(false);
      }
    }
  });
});

describe('copy that must match the product', () => {
  const src = (f: string) => readFileSync(path.join(process.cwd(), f), 'utf8');
  it('does not promise 2FA backup codes (TwoFactorSection ships TOTP only)', () => {
    for (const f of ['src/components/landing/faqData.ts', 'pages/login.tsx', 'public/llms.txt']) {
      expect(src(f), f).not.toMatch(/backup code/i);
    }
  });
});
