/**
 * What src/lib/fonts.ts asks next/font/local for. next/font is a build-time transform, so under Vitest the
 * call is recorded instead of run: this pins the options the build is given (the CSS variable the Tailwind
 * `sans` stack reads, the variable weight range, swap, and a woff2 that exists), not the source text.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('next/font/local', () => ({
  default: (options: Record<string, unknown>) => { calls.push(options); return { variable: '__v', className: '__c', style: { fontFamily: 'x' } }; },
}));

import { dmSans } from '@/lib/fonts';
import tailwindConfig from '../../../tailwind.config.mjs';

describe('dmSans (self-hosted)', () => {
  it('loads one variable DM Sans file with the variable and display the app relies on', () => {
    expect(dmSans.variable).toBe('__v');
    expect(calls).toHaveLength(1);
    const options = calls[0] ?? {};
    expect(options.variable).toBe('--font-dm-sans');
    expect(options.weight).toBe('100 1000');
    expect(options.display).toBe('swap');
    const src = String(options.src);
    expect(src.endsWith('.woff2')).toBe(true);
    const file = path.resolve(__dirname, '../../../src/lib', src);
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2');
  });

  it('is the family Tailwind\'s sans stack reads, so font-sans is DM Sans', () => {
    const sans = (tailwindConfig.theme.extend.fontFamily.sans as string[]).join(',');
    expect(sans).toContain(`var(${String(calls[0]?.variable)}`);
  });
});
