/**
 * UNICODE'S NUMERIC RULE, AS PRODUCTION'S CHROMIUM APPLIES IT, in a throwaway container of production's Gotenberg image:
 *  - on the numeric census and the blind review's 60,000-string pool (`print/fixtures/numericCensus.ts`), the splitter
 *    breaks where production breaks, and nowhere else (the pair table and `packNumericHold.ts` together);
 *  - with REGENERATE_NUMERIC=1 and LINE_BREAK_TXT (Unicode's LineBreak.txt), the classes the rule reads are written
 *    afresh to `packNumericClassData.ts`: Unicode's, less the signs and openers production holds no number beside
 *    (`lineBreakClasses.numericProbes`, probed here).
 * Velo only, as the pair table's image test. Re-run it whenever the gotenberg image changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAIR_DOMAIN } from './breakPairsDomain';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { breaksInImage } from './inImage';
import { notInNumbers, numericClassSource, numericProbes, parseLineBreak } from './lineBreakClasses';
import { paritySkip } from './paritySkip';
import { BREAKS_OF, modelBreaks, readBreaks } from '../print/fixtures/breakPairsCensus';
import { NUMERIC_CENSUS, numericPool } from '../print/fixtures/numericCensus';

const DATA = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packNumericClassData.ts');
const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`the numeric rule in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('on the numeric census and the blind review\'s pool, the splitter breaks where production\'s Chromium breaks, and nowhere else', async () => {
    const texts = [...NUMERIC_CENSUS, ...numericPool()];
    const got = await breaksInImage(gotenberg!, BREAKS_OF, texts);
    let breaks = 0;
    const wrong = texts.flatMap((t, i) => {
      const { real, blind } = readBreaks(t, got[i]!);
      const model = modelBreaks(t).filter((b) => !blind.has(b));
      breaks += real.length;
      return real.join(',') === model.join(',') ? [] : [`${JSON.stringify(t)}: production ${real.join(',')} model ${model.join(',')}`];
    });
    expect(wrong.slice(0, 20), `${wrong.length} of ${texts.length} differ`).toEqual([]);
    expect(breaks, 'breaks read').toBeGreaterThan(50_000);
  }, 1_800_000);

  it.skipIf(process.env.REGENERATE_NUMERIC !== '1')('REGENERATE_NUMERIC=1: probes the classes in production and writes packNumericClassData.ts', async () => {
    const classes = parseLineBreak(readFileSync(process.env.LINE_BREAK_TXT!, 'utf8'));
    const probes = numericProbes(classes, PAIR_DOMAIN());
    const got = await breaksInImage(gotenberg!, BREAKS_OF, probes.map((p) => p.text));
    const left = notInNumbers(probes, got.map((b) => b.filter((x) => x > 0)));
    process.stdout.write(`NUMERIC ${probes.length} probes, ${left.size} code points left out: ${[...left].map((c) => String.fromCodePoint(c)).join(' ')}\n`);
    writeFileSync(DATA, numericClassSource(classes, left));
  }, 1_800_000);
});
