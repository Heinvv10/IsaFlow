/**
 * Shared email footer (emailLayout): plain wording, no dead links, and footer
 * text readable on the footer background (WCAG AA 4.5:1).
 */
import { describe, it, expect } from 'vitest';
import { emailLayout, emailContentRow, BRAND } from '@/lib/email-templates-shared';

function footerHtml(): string {
  const html = emailLayout(emailContentRow('<p>Body</p>'));
  const start = html.indexOf(`background-color:${BRAND.footerBg}`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</body>'));
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('emailLayout footer', () => {
  it('names IsaFlow without an em dash', () => {
    const footer = footerHtml();
    expect(footer).toContain('IsaFlow, South African cloud accounting.');
    expect(footer).not.toMatch(/&#8212;|&mdash;|—/);
  });

  it('has no "do not reply" line', () => {
    expect(footerHtml().toLowerCase()).not.toContain('do not reply');
  });

  it('has no link to the non-existent /preferences page', () => {
    const footer = footerHtml();
    expect(footer).not.toContain('/preferences');
    expect(footer).not.toContain('Manage email preferences');
  });

  it('keeps the app.isaflow.co.za link', () => {
    expect(footerHtml()).toContain(`<a href="${BRAND.appUrl}"`);
    expect(footerHtml()).toContain('app.isaflow.co.za</a>');
  });

  it('uses footer text with at least 4.5:1 contrast on the footer background', () => {
    const footer = footerHtml();
    const colours = [...footer.matchAll(/(?<!background-)color:(#[0-9a-fA-F]{6})/g)].map((m) => m[1]!);
    const textColours = colours.filter((c) => c !== BRAND.primaryTeal);
    expect(textColours.length).toBeGreaterThan(0);
    for (const c of textColours) {
      expect(contrast(c, BRAND.footerBg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('has no em dash anywhere in the layout text', () => {
    const html = emailLayout(emailContentRow('<p>Body</p>'));
    expect(html).not.toMatch(/&#8212;|&mdash;|—/);
  });
});
