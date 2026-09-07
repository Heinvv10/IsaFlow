// tests/unit/print/fontsSelfHosted.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'styles/packPrint.css'), 'utf8');

const FACES = [
  'IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2',
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
    expect(CSS).toMatch(/font-feature-settings:\s*"tnum" 1/);
  });

  it('loads no monospace face at all', () => {
    // The pack is ONE typeface. Every figure position — tiles, statement
    // cells, contents numbers, the matters quantum column, the scorecard's
    // status words — used to be set in IBM Plex Mono against IBM Plex Sans
    // prose, which reads as a renderer fallback rather than as a decision.
    // Alignment comes from `tnum` on the text face instead. A file that
    // references the face again would also ship two more woff2 payloads into
    // every PDF.
    expect(CSS).not.toMatch(/IBMPlexMono/);
    expect(CSS).not.toMatch(/pack-font-mono/);
  });
});
