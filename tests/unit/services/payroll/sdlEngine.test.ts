import { describe, it, expect } from 'vitest';
import { calculateSDL } from '@/modules/accounting/services/payroll/sdlEngine';

describe('SDL engine', () => {
  it('charges 1% when annual payroll exceeds R500,000', () => {
    const sdl = calculateSDL(25_000, 700_000, 2025);
    expect(sdl).toBeCloseTo(250, 2);
  });

  it('zero when annual payroll is below R500,000', () => {
    const sdl = calculateSDL(25_000, 400_000, 2025);
    expect(sdl).toBe(0);
  });

  it('zero when annual payroll exactly equals R500,000', () => {
    const sdl = calculateSDL(25_000, 500_000, 2025);
    expect(sdl).toBe(0);
  });

  it('charges 1% when annual payroll is R500,001', () => {
    const sdl = calculateSDL(25_000, 500_001, 2025);
    expect(sdl).toBeCloseTo(250, 2);
  });

  it('zero monthly salary → zero SDL even with large payroll', () => {
    const sdl = calculateSDL(0, 1_000_000, 2025);
    expect(sdl).toBe(0);
  });
});
