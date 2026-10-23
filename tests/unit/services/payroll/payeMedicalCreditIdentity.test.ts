/**
 * PAYE 4a follow-ups round 2, R3, §6 gate: recording the medical scheme fees
 * tax credit a line applied (payroll_run_lines.medical_credit, migration 926)
 * must not change any PAYE figure. fixtures/paye-identity.golden.json holds
 * the calculator's figures for the grid (fixtures/payeIdentityGrid.ts) as
 * written by the code BEFORE the change (base 609f31e86, `PAYE_GOLDEN_WRITE=1`);
 * every case must reproduce them exactly, except an employee 65 or older
 * with medical scheme fees, whose PAYE the additional medical expenses tax
 * credit (R3 part 2, Hein 2026-10-23) may lower.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { payeFigures, payeIdentityGrid } from './fixtures/payeIdentityGrid';

const GOLDEN = join(__dirname, 'fixtures', 'paye-identity.golden.json');

describe('R3: PAYE is unchanged by recording the medical credit', () => {
  const grid = payeIdentityGrid();
  const actual = Object.fromEntries(grid.map(c => [c.name, payeFigures(c.run())]));

  if (process.env.PAYE_GOLDEN_WRITE === '1') {
    it('writes the golden file', () => {
      // One case per line, so a diff names the case that moved.
      writeFileSync(GOLDEN, `{\n${Object.entries(actual).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`);
    });
    return;
  }

  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;

  it('covers the whole grid, no case added or lost', () => {
    expect(grid.length).toBeGreaterThan(1_000);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });

  // Everyone but an employee 65 or older paying medical aid through payroll: byte-identical.
  it.each(grid.filter(c => !c.over65WithFees).map(c => c.name))('%s', (name) => {
    expect(actual[name]).toEqual(golden[name]);
  });

  // 65 or older with 4005 fees: the additional medical expenses tax credit (Hein 2026-10-23) may only
  // lower the PAYE (exact figures: payeAdditionalMedicalCredit.test.ts); nothing else on the line moves.
  it.each(grid.filter(c => c.over65WithFees).map(c => c.name))('%s (65+, fees: PAYE may only fall)', (name) => {
    const now = actual[name] as { paye: { monthlyPaye: number }; payeSplit: unknown };
    const was = golden[name] as typeof now;
    expect(now.paye.monthlyPaye).toBeLessThanOrEqual(was.paye.monthlyPaye);
    const rest = (x: Record<string, unknown>) => ({ ...x, paye: undefined, payeSplit: undefined, netPay: undefined });
    expect(rest(now as never)).toEqual(rest(was as never));
  });
});
