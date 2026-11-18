/**
 * PAYE 4a follow-ups round 2, R3, §6 gate: recording the medical scheme fees
 * tax credit a line applied (payroll_run_lines.medical_credit, migration 926)
 * must not change any PAYE figure. fixtures/paye-identity.golden.json holds
 * the calculator's figures for the grid (fixtures/payeIdentityGrid.ts) as
 * written by the code BEFORE the change (base 609f31e86, `PAYE_GOLDEN_WRITE=1`);
 * every case must reproduce them exactly, except an employee 65 or older
 * with medical scheme fees, whose PAYE the additional medical expenses tax
 * credit (R3 part 2, Hein 2026-10-23) may lower.
 *
 * Wave-6 AN (PAYROLL_CALCULATION_VERSION 13) regenerated the golden (`PAYE_GOLDEN_WRITE=1`): days-based
 * annualisation (365 ÷ 30.4166, ruling 5; the medical credits stay monthly amounts, n ÷ 12, coordinator ruling
 * 2026-11-17) moves PAYE on 325 of the 1 154 rows by 1c to 14c and nothing else; a
 * golden written with the monthly factor set back to 12 equalled the previous file on every row but the 29 65+ rows
 * the additional credit lowers. So the golden now holds the 65+ rows with that credit, and the rows below give the
 * hand figures with and without it.
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

  // Hand figures, first period, R20 000, member only (one beneficiary), fees R1 500 a month. Under AN (F = 365 ÷
  // 30.4166) the annual equivalent is 20 000 x F = 240 000.53, and a month is the tax after rebates ÷ F less the credits
  // ÷ 12 (monthly amounts: fees a year 1 500 x 12 = 18 000). (Under x12, as R3 wrote them: 925.25 -> 801.37,
  // 654.50 -> 530.62, 1 032.08 -> 896.22.)
  // 2027: MTC 4 512, AMTC 33,3% x (18 000 - 13 536) = 1 486.512; tax(240 000.53) = 43 200.09.
  //   66: (43 200.09 - 17 820 - 9 765) ÷ F - 4 512 ÷ 12 = 925.26 a month; - 1 486.512 ÷ 12 -> 801.38.
  //   76: (15 615.09 - 3 249) ÷ F - 376 = 654.51; - 123.876 -> 530.63.
  // 2026: MTC 4 368, AMTC 33,3% x (18 000 - 13 104) = 1 630.368; tax(240 000.53) = 42 678 + 26% x 2 900.53.
  //   66: (43 432.14 - 17 235 - 9 444) ÷ F - 364 = 1 032.09; - 135.864 -> 896.23.
  it.each([
    ['2027 age 66 ben 1 salary 20000 bonus 0 first period', 925.26, 801.38],
    ['2027 age 76 ben 1 salary 20000 bonus 0 first period', 654.51, 530.63],
    ['2026 age 66 ben 1 salary 20000 bonus 0 first period', 1_032.09, 896.23],
  ] as const)('%s: %s without the additional credit, %s with it (hand)', (name, without, withCredit) => {
    expect((actual[name] as { paye: { monthlyPaye: number } }).paye.monthlyPaye).toBe(withCredit);
    expect(withCredit).toBeLessThan(without);
  });
  it('a 65+ member + 1 row with R1 500 fees stays below 3 x MTC and is identical (2027 age 66 ben 2)', () => {
    const name = '2027 age 66 ben 2 salary 20000 bonus 0 first period';
    expect(grid.find(c => c.name === name)!.amtcMayApply).toBe(false);
    expect(actual[name]).toEqual(golden[name]);
  });
});
