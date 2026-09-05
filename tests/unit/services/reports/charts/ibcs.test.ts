import { describe, it, expect } from 'vitest';
import { DEFAULT_PALETTE, paletteFromTheme } from '@/components/accounting/charts/chartTypes';
import { roleStyle, varianceColor, axisDomain } from '@/components/accounting/charts/ibcs';
import { buildTheme } from '@/lib/charts/theme';

const P = DEFAULT_PALETTE;

describe('roleStyle', () => {
  it('draws actual as solid ink with no border', () => {
    const s = roleStyle('actual', P);
    expect(s.color).toBe(P.ink);
    expect(s.borderWidth ?? 0).toBe(0);
    expect(s.decal).toBeUndefined();
  });

  it('draws prior in the light grey token, never in ink', () => {
    const s = roleStyle('prior', P);
    expect(s.color).toBe(P.prior);
    expect(s.color).not.toBe(P.ink);
  });

  it('draws budget as an outline: transparent fill, ink border', () => {
    const s = roleStyle('budget', P);
    expect(s.color).toBe('transparent');
    expect(s.borderColor).toBe(P.ink);
    expect(s.borderWidth).toBeGreaterThan(0);
  });

  it('draws forecast hatched', () => {
    const s = roleStyle('forecast', P);
    expect(s.decal).toBeDefined();
    expect(s.decal?.rotation).toBeCloseTo(-Math.PI / 4);
  });

  it('never returns the favourable or unfavourable colour for a role', () => {
    for (const role of ['actual', 'prior', 'budget', 'forecast'] as const) {
      const s = roleStyle(role, P);
      expect([s.color, s.borderColor]).not.toContain(P.fav);
      expect([s.color, s.borderColor]).not.toContain(P.unfav);
    }
  });
});

describe('varianceColor', () => {
  it('is the only place green and red are issued', () => {
    expect(varianceColor(true, P)).toBe(P.fav);
    expect(varianceColor(false, P)).toBe(P.unfav);
  });
  it('leaves an unknown polarity uncoloured rather than guessing', () => {
    expect(varianceColor(undefined, P)).toBeUndefined();
  });
});

describe('axisDomain', () => {
  it('always includes zero, so no bar is drawn on a truncated axis', () => {
    expect(axisDomain([100, 120, 140]).min).toBe(0);
    expect(axisDomain([-40, -10]).max).toBe(0);
  });
  it('spans both signs when the data does', () => {
    const d = axisDomain([-50, 200]);
    expect(d.min).toBeLessThan(-50);
    expect(d.max).toBeGreaterThan(200);
  });
  it('gives a flat all-zero series a usable domain instead of min === max', () => {
    const d = axisDomain([0, 0, 0]);
    expect(d.max).toBeGreaterThan(d.min);
  });
});

describe('paletteFromTheme', () => {
  it('takes ink, prior and plan from the theme colour order, not by index guess', () => {
    const theme = buildTheme(() => '');
    const p = paletteFromTheme(theme);
    expect(p.ink).toBe(theme.color[0]);
    expect(p.prior).toBe(theme.color[1]);
    expect(p.plan).toBe(theme.color[2]);
    expect(p.fav).toBe(theme.favColor);
    expect(p.unfav).toBe(theme.unfavColor);
  });
});
