/**
 * A ROW LABEL THAT CARRIES A MARK, IN PRODUCTION'S IMAGE: set in the statement table's own label cell
 * (`pack-label-anywhere`, the pack's stylesheet) at three widths and three weights, its lines are never more than the
 * model's (`packTableLayout.labelLineCount`, which reads such a label by `packAnywhereLabel.ts`). The labels: every
 * combining mark and variation selector Unicode has, on bases whose fallback glyph is wider than the face's (#1235 round
 * 7: \u00AE | \u2122 \u2014 \u0640 M and the rest) and on ASCII and Latin-1 signs, alone, doubled and inside a word; and
 * the marked census (`everyBreakCensus.markedCensus`). The statement tables these labels sit in (column widths, height,
 * the page) are `packBreakPairsImage.test.ts`'s round labels. Velo only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labelLineCount } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { WRAP_GUARD_PX } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { carriesMarks, printedText } from '@/modules/accounting/services/packs/pages/packPrintedText';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { markedCensus } from '../print/fixtures/everyBreakCensus';

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

/** The bases a mark is tried on: the round-7 reviews' widest-fallback ones, signs, letters. */
const BASES = ['\u00AE', '|', '\u2122', '\u2014', '\u0640', 'M', 'W', '\u00A6', '\u0448', '\u01B0', '\u2211', '\u2192', '\u00B6', '\u00D7', '?', '/', '!', '}', '\u00B0', '\u00A3', 'n', 'A', '1', '&'];

function labels(): string[] {
  const out = new Set<string>();
  for (let cp = 0x300; cp <= 0x1ffff; cp += 1) {
    const m = String.fromCodePoint(cp);
    if (!/^\p{M}$/u.test(m)) continue;
    for (const b of BASES) { out.add(`${b}${m}`); out.add(`${b}${m}${b}${m}`); }
    out.add(`Telecom\u00AE${m}munications`);
  }
  for (const t of markedCensus()) out.add(t);
  return [...out].map(printedText).filter(carriesMarks);
}

const WIDTHS = [18, 48, 120];

describe.skipIf(unavailable !== null)(`labels printed to break anywhere, in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('every mark on wide-fallback bases and signs, and the marked census, at three widths and three weights: never a line more than the model', async () => {
    const texts = labels();
    expect(texts.length).toBeGreaterThan(100_000);
    const wrong: string[] = [];
    let held = 0;
    for (const weight of [400, 500, 600] as const) {
      for (const w of WIDTHS) {
        for (let at = 0; at < texts.length; at += 6000) {
          const slice = texts.slice(at, at + 6000);
          const script = `function answer() {
  var host = document.getElementById('scan');
  return ${JSON.stringify(slice)}.map(function (t) {
    var table = document.createElement('table'); table.className = 'pack-table'; table.style.cssText = 'width:auto;table-layout:fixed';
    var td = document.createElement('td'); td.style.cssText = 'width:${w}px;padding:0;font-weight:${weight}';
    var span = document.createElement('span'); span.className = 'pack-label-anywhere'; span.textContent = t;
    var tr = document.createElement('tr'); td.appendChild(span); tr.appendChild(td); table.appendChild(tr); host.appendChild(table);
    var r = document.createRange(); r.selectNodeContents(span.firstChild);
    var tops = {}; Array.from(r.getClientRects()).forEach(function (x) { tops[Math.round(x.top)] = 1; });
    host.removeChild(table);
    return 'L|' + Object.keys(tops).length;
  });
}`;
          const got = (await inImage(gotenberg!, script)).filter((l) => l.startsWith('L|')).map((l) => Number(l.slice(2)));
          expect(got.length, 'the image\'s lines came back incomplete').toBe(slice.length);
          slice.forEach((t, i) => {
            const model = labelLineCount(t, null, weight, w, WRAP_GUARD_PX);
            held += 1;
            if (model < got[i]!) wrong.push(`${JSON.stringify(t)} at ${w}px/${weight}: model ${model} lines, production ${got[i]}`);
          });
        }
      }
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${held}`).toEqual([]);
  }, 3_600_000);
});
