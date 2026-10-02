/**
 * `pitchedAxisDomain` AIMS FOR A COMFORTABLE PITCH AND NEVER GOES UNDER A
 * LEGIBLE ONE.
 *
 * Its comment promised a step every 26px; what it did was ask for that and
 * accept whatever the rounding returned down to 18. Zero to 800 in a 100px
 * plot, asked for three steps, came back with four at 25px. The ask is now
 * lowered until the drawn count is the comfortable one wherever any ask
 * gives it, and the 18px floor is the fallback, not the target.
 */
import { describe, expect, it } from 'vitest';
import { axisDomain, MIN_TICK_PITCH_PX, pitchedAxisDomain, TICK_PITCH_PX } from '@/modules/accounting/services/packs/packChartAxes';

describe('pitchedAxisDomain', () => {
  it('draws 0 to 800 in a 100px plot at the comfortable pitch, not four steps at 25px', () => {
    const domain = pitchedAxisDomain([0, 800], 100);
    expect(100 / domain.splitNumber).toBeGreaterThanOrEqual(TICK_PITCH_PX);
    expect(domain.interval).toBe((domain.max - domain.min) / domain.splitNumber);
    expect(domain.min).toBeLessThanOrEqual(0);
    expect(domain.max).toBeGreaterThanOrEqual(800);
  });

  it('never puts two ticks closer than the legible floor, and reaches the comfortable pitch wherever any ask gives it', () => {
    let seed = 20_261_010;
    const rnd = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const under: string[] = [];
    let comfortable = 0;
    let roomy = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const mag = Math.pow(10, 1 + rnd() * 9);
      const values = [Math.round((rnd() - 0.5) * 2 * mag), Math.round((rnd() - 0.5) * 2 * mag)];
      const plotPx = 10 + Math.floor(rnd() * 330);
      const domain = pitchedAxisDomain(values, plotPx);
      if (domain.max === domain.min) continue;
      const pitch = plotPx / domain.splitNumber;
      if (domain.splitNumber > 1 && pitch < MIN_TICK_PITCH_PX) under.push(`${JSON.stringify(values)} in ${plotPx}px: ${domain.splitNumber} steps`);
      if (domain.min > Math.min(0, ...values) || domain.max < Math.max(0, ...values)) under.push(`${JSON.stringify(values)} is outside ${domain.min}..${domain.max}`);
      // Reachable: some step count asked of `axisDomain` rounds to an axis
      // with no more steps than the plot holds at the comfortable pitch.
      const target = Math.floor(plotPx / TICK_PITCH_PX);
      const reachable = Array.from({ length: 12 }, (_, k) => axisDomain(values, k + 1)).some((d) => d.splitNumber <= target);
      if (reachable) { roomy += 1; if (pitch >= TICK_PITCH_PX) comfortable += 1; }
    }
    expect(under.slice(0, 5)).toEqual([]);
    expect(roomy).toBeGreaterThan(10_000);
    expect(comfortable).toBe(roomy);
  });
});
