/**
 * The welcome email's copy and its own layout (Hein's review of the rendered previews, 24 Nov 2026):
 *   - footer without an em dash, a "do not reply" line or the dead /preferences link
 *   - footer text at 4.5:1 or better on the footer background
 *   - no emoji feature icons, no unverifiable claims, heading without "!"
 *   - the contact line linking LEGAL_ENTITY.contactEmail
 */
import { describe, it, expect } from 'vitest';
import { welcomeEmailHtml, WELCOME_FOOTER_TEXT, type WelcomeVariant } from '@/lib/email-templates-auth';
import { BRAND } from '@/lib/email-templates-shared';
import { LEGAL_ENTITY } from '@/config/legalEntity';

const VARIANTS: WelcomeVariant[] = ['sme', 'accountant'];
const render = (variant: WelcomeVariant) =>
  welcomeEmailHtml({ name: 'Thandi', companyName: 'Example Traders', variant, trialDays: 14 });

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe.each(VARIANTS)('welcome email (%s)', (variant) => {
  const html = render(variant);

  it('has no em dash, en dash or their entities anywhere', () => {
    expect(html).not.toMatch(/[—–]|&mdash;|&ndash;|&#8212;|&#8211;/);
  });

  it('has its own footer: no "do not reply", no /preferences link', () => {
    expect(html).not.toMatch(/do not reply/i);
    expect(html).not.toContain('/preferences');
    expect(html).toContain('IsaFlow, South African cloud accounting.');
    expect(html).toContain('You are receiving this because you signed up for IsaFlow.');
  });

  it('uses the footer text colour, which meets 4.5:1 on the footer background', () => {
    expect(contrast(WELCOME_FOOTER_TEXT, BRAND.footerBg)).toBeGreaterThanOrEqual(4.5);
    expect(html).toContain(`color:${WELCOME_FOOTER_TEXT}; line-height:1.5;">
          IsaFlow, South African cloud accounting.`);
  });

  it('has no emoji, as characters or as numeric entities', () => {
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    const entities = [...html.matchAll(/&#(\d+);/g)].map((m) => Number(m[1]));
    expect(entities.filter((n) => n > 0x2000)).toEqual([]);
  });

  it('makes no unverifiable claims', () => {
    expect(html).not.toMatch(/in seconds|professional|instantly|effortless|easiest|best|fastest/i);
  });

  it('heads with "Welcome to IsaFlow" and no exclamation mark', () => {
    expect(html).toMatch(/<h1[^>]*>\s*Welcome to IsaFlow\s*<\/h1>/);
    const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
    expect(visible).not.toContain('!');
  });

  it('carries the contact line linking the accounts address', () => {
    const mail = LEGAL_ENTITY.contactEmail;
    expect(html).toContain(`Questions? Email us at <a href="mailto:${mail}" style="color:${BRAND.primaryTeal};">${mail}</a>.`);
  });
});
