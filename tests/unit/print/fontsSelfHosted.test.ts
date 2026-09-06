// tests/unit/print/fontsSelfHosted.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'styles/packPrint.css'), 'utf8');

const FACES = [
  'IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2',
  'IBMPlexMono-Regular.woff2', 'IBMPlexMono-Medium.woff2',
];

describe('self-hosted print fonts', () => {
  it('ships every face the print CSS references', () => {
    for (const face of FACES) {
      expect(existsSync(join(ROOT, 'public/fonts', face)), face).toBe(true);
      expect(CSS).toContain(`/fonts/${face}`);
    }
  });

  it('ships the OFL licence alongside them', () => {
    expect(existsSync(join(ROOT, 'public/fonts/OFL.txt'))).toBe(true);
  });

  it('references no third-origin font host', () => {
    // Gotenberg's Chromium allow-list blocks a CDN silently: correct under
    // Playwright, wrong under Gotenberg. This is the guard against that.
    expect(CSS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|cdn\.jsdelivr/);
    expect(CSS).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
  });

  it('declares tabular figures on the sans face', () => {
    expect(CSS).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
