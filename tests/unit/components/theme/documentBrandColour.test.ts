/**
 * Documents carry the brand colour too: white-on-teal in an email button or a report header must
 * clear AA (the old #14b8a6 was 2.49:1), so the app and its documents use the same #0f766e.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '@/lib/email-templates-shared';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('document brand colour', () => {
  it('the email button fill carries white text at AA', () => {
    expect(ratio(BRAND.primaryTeal, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('the report HTML export uses no #14b8a6 (white-on-teal headers, teal text on white)', () => {
    const src = readFileSync(join(process.cwd(), 'pages/api/accounting/reports-html.ts'), 'utf8');
    expect(src.toLowerCase()).not.toContain('#14b8a6');
    expect(src).toContain(BRAND.primaryTeal);
  });
});
