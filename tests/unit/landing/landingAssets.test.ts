/**
 * Every /landing/ asset the site references exists, and the feature screenshots and
 * nav logo are the small pre-encoded webp files (next.config sets images.unoptimized,
 * so nothing resizes them at runtime).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DETAILED_FEATURES } from '@/components/landing/landingData';

const ROOT = join(__dirname, '../../..');
const PUBLIC_LANDING = join(ROOT, 'public/landing');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?|css)$/.test(p) ? [p] : [];
  });
}

describe('landing assets', () => {
  it('every referenced /landing/ file exists', () => {
    const refs = new Set<string>();
    for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))]) {
      for (const m of readFileSync(file, 'utf8').matchAll(/['"`(]\/landing\/([^'"`)$]+)['"`)]/g)) refs.add(m[1]!);
    }
    expect(refs.size).toBeGreaterThan(0);
    for (const r of refs) expect(existsSync(join(PUBLIC_LANDING, r)), r).toBe(true);
  });

  it.each(DETAILED_FEATURES.map((f) => f.imgKey))('%s screenshot is a small webp at 1200 and 640 wide', (key) => {
    expect(statSync(join(PUBLIC_LANDING, `${key}-1200.webp`)).size).toBeLessThan(120 * 1024);
    expect(statSync(join(PUBLIC_LANDING, `${key}-640.webp`)).size).toBeLessThan(50 * 1024);
  });

  it('nav logo is a small webp', () => {
    expect(statSync(join(PUBLIC_LANDING, 'logo-nav.webp')).size).toBeLessThan(20 * 1024);
  });
});
