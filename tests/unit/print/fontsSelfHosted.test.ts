// tests/unit/print/fontsSelfHosted.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACK_FONT_FAMILY, PACK_FONT_WEIGHTS } from '@/components/accounting/packs/usePrintMode';

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

  /**
   * THE READINESS GATE WAITS FOR A LIST, AND THE LIST HAS TO BE THIS ONE.
   *
   * `usePrintReady` holds the page back until every face in
   * `PACK_FONT_WEIGHTS` has loaded, because a face declared `font-display:
   * block` that has not arrived prints NOTHING. A weight declared here and
   * missing from that list is a weight nothing waits for — which is the race
   * that produced a twelve-sheet pack with no figures on it.
   */
  it('declares exactly the faces the print-ready gate waits for', () => {
    const declared = [...CSS.matchAll(/@font-face\s*{[^}]*}/g)]
      .filter((rule) => rule[0].includes(PACK_FONT_FAMILY))
      .map((rule) => Number(/font-weight:\s*(\d+)/.exec(rule[0])?.[1]));

    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...PACK_FONT_WEIGHTS].sort());
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
