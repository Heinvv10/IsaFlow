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

  // Everyone but a 65+ employee whose fees exceed three times the MTC: byte-identical (most 65+ rows included).
  it.each(grid.filter(c => !c.amtcMayApply).map(c => c.name))('%s', (name) => {
    expect(actual[name]).toEqual(golden[name]);
  });

  // 65+ with fees above 3 x MTC: the additional medical expenses tax credit (Hein 2026-10-23) may only
  // lower the PAYE; nothing else on the line moves. Exact figures for three rows below, the rest in
  // payeAdditionalMedicalCredit.test.ts.
  it.each(grid.filter(c => c.amtcMayApply).map(c => c.name))('%s (65+, fees above 3 x MTC: PAYE may only fall)', (name) => {
    const now = actual[name] as { paye: { monthlyPaye: number }; payeSplit: unknown };
    const was = golden[name] as typeof now;
    expect(now.paye.monthlyPaye).toBeLessThanOrEqual(was.paye.monthlyPaye);
    const rest = (x: Record<string, unknown>) => ({ ...x, paye: undefined, payeSplit: undefined, netPay: undefined });
    expect(rest(now as never)).toEqual(rest(was as never));
  });

  // Hand figures, first period, R20 000, member only (one beneficiary), fees R1 500: annual 18 000.
  // 2027: MTC 4 512, AMTC 33,3% x (18 000 - 13 536) = 1 486.512; tax(240 000) = 43 200.
  //   66: 43 200 - 17 820 - 9 765 - 4 512 = 11 103 (925.25 a month); - 1 486.512 = 9 616.488 -> 801.37.
  //   76: 11 103 - 3 249 = 7 854 (654.50); - 1 486.512 = 6 367.488 -> 530.62.
  // 2026: MTC 4 368, AMTC 33,3% x (18 000 - 13 104) = 1 630.368; tax(240 000) = 42 678 + 26% x 2 900 = 43 432.
  //   66: 43 432 - 17 235 - 9 444 - 4 368 = 12 385 (1 032.08); - 1 630.368 = 10 754.632 -> 896.22.
  it.each([
    ['2027 age 66 ben 1 salary 20000 bonus 0 first period', 925.25, 801.37],
    ['2027 age 76 ben 1 salary 20000 bonus 0 first period', 654.5, 530.62],
    ['2026 age 66 ben 1 salary 20000 bonus 0 first period', 1_032.08, 896.22],
  ] as const)('%s: %s before, %s after (hand)', (name, before, after) => {
    expect((golden[name] as { paye: { monthlyPaye: number } }).paye.monthlyPaye).toBe(before);
    expect((actual[name] as { paye: { monthlyPaye: number } }).paye.monthlyPaye).toBe(after);
  });
  it('a 65+ member + 1 row with R1 500 fees stays below 3 x MTC and is identical (2027 age 66 ben 2)', () => {
    const name = '2027 age 66 ben 2 salary 20000 bonus 0 first period';
    expect(grid.find(c => c.name === name)!.amtcMayApply).toBe(false);
    expect(actual[name]).toEqual(golden[name]);
  });
});
