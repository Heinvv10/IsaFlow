/**
 * THE PROSE MODEL NEVER READS A LINE SHORT OF PRODUCTION'S, IN PRODUCTION'S IMAGE (the prose PR, Hein 11-10).
 * `packProseLines.proseLines` sets each word at the faces' widths and a character the faces lack from the fallback
 * tables; `packProseBound.proseLinesBound`, the commentary gate's, at the generated upper bound. Both are held here
 * against Gotenberg's Chromium on the pack's own prose rules (a disclosure's body, page 4's commentary, a footnote) at
 * four measures, on the scripts and spaces the em table mispriced: CJK, set spaces, U+2007 and ZWNBSP inside a word, "%"
 * "@" "&", long words. The CI Chromium's fallback faces are not production's, so this text is held only here
 * (`tests/unit/print/packTextMetrics.test.ts` holds the faces' text there).
 *
 * And on what round 1 found short (#1263): CJK runs of 60 to 200 characters in the matters' columns, which break between
 * their ideographs, and tokens wider than a line with breaks inside them; and at the model's own boundary width.
 *
 * Not held: a joined script in a fallback face (Syriac SADHE is 7.52px alone, about 10.3px joined, and 80 of them read a
 * line short): the KNOWN LIMIT `packProseLines` records, reached by no fixture. Velo only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUTTER_MM, PAGE_WIDTH_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE_FACES } from '@/modules/accounting/services/packs/pages/packProseFallbackData';
import { PROSE, type ProseStyle } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { paritySkip } from './paritySkip';
import { inBlock, inMattersCell, MM_PX, shortCells, type Cell } from './proseCells';

const rep = (s: string, n: number, sep = ''): string => Array.from({ length: n }, () => s).join(sep);

const TEXTS: readonly string[] = [
  'Targets are the platform defaults; a metric with no target is shown unscored rather than assumed met, and the page says so.',
  'Reversal of JE-2026-00417 against company d27bac33-0000-0000-0000-000000000000 on 2026-01-31, 1 234 567.89',
  'VAT CONTROL ACCOUNT RECONCILIATION FOR THE PERIOD ENDED 31 AUGUST 2026 \u2014 SARS VAT201 SUBMISSION',
  'Die grootboekinskrywing is teruggeskryf omdat die bedrag nie ooreenstem met die staat se saldo nie.',
  '这是一笔来自客户的付款，金额与银行对账单上的余额不符，需要财务部门在本月底之前完成核对。',
  '株式会社テストへの支払い、三月分の家賃',
  '이 분개는 은행 명세서의 잔액과 일치하지 않으므로 월말까지 회계 부서의 확인이 필요합니다.',
  `Rent${rep('\u3000', 16)}March`, `Rent${rep('\u2003', 16)}March`, `Rent ${rep(`x${rep('\u3000', 8)}`, 10, ' ')}`,
  `Rent ${rep(`x${rep('\u2003', 8)}`, 10, ' ')}`, `Rent ${rep(`${rep('0000\u2007', 8)}0000`, 5, ' ')}`,
  `Rent ${rep(`${rep(`${rep('x', 10)}\uFEFF`, 5)}${rep('x', 10)}`, 10, ' ')}`,
  rep('%%%% ', 40), rep('@@@@ ', 30), rep('&&&& ', 30), rep('\u00C0\u00C9\u00D6\u00DC ', 30),
  rep('aeonudhbpq ', 30), rep('mmmmmmmm ', 25), rep('\u30D0\u30F3', 60), `\u23B0${rep('\u2350', 60)}`,
  rep('r\u200C\u2019 ', 40), rep('\u{1F600} ', 40), rep('\u0E01\u0E32\u0E23 ', 30),
  'Journal JE-2026-00061 (recorded well after its entry date): Payroll run 2026-01 posted to the wrong period by the bureau.',
];

const W = PAGE_WIDTH_MM.portrait;
/** The pack's prose rules: a disclosure's body, page 4's commentary, a footnote. */
const KINDS: ReadonlyArray<{ cell: ReturnType<typeof inBlock>; style: ProseStyle; mm: number }> = [
  { cell: inBlock('pack-disclosure-body', 'p'), style: PROSE.disclosureBody, mm: W },
  { cell: inBlock('pack-narrative-body'), style: PROSE.narrativeBody, mm: W },
  { cell: inBlock('pack-footnote-text', 'span', 'line-height:11pt;'), style: PROSE.footnote, mm: W - 6 },
];
const FRACTIONS = [1, 0.8, 0.6, 0.45];

const CHINESE = '这是一笔来自客户的付款，金额与银行对账单上的余额不符，需要财务部门在本月底之前完成核对。'.repeat(8);
const JAPANESE = '株式会社テストへの支払い、三月分の家賃は銀行明細の残高と一致しないため、月末までに経理部門による照合が必要です。'.repeat(6);
/** The matters' column widths (`mattersColumnsMm`): the owner and decision columns, the issue column at its three. */
const MATTERS_MM = [24.4, 31.5, 34, 43.4, 52.8, 67, 90.7];
/** Tokens wider than a line with break opportunities inside them (the blind review of #1263, H1). */
const LONG_TOKENS = [
  `Note ${Array.from({ length: 6 }, () => 'm'.repeat(40)).join('-')} end`, Array.from({ length: 6 }, () => 'a'.repeat(30)).join('-'),
  '%'.repeat(200), 'm'.repeat(1400),
  'The schedules are in Q3-board-pack-final-v2-reviewed-by-audit-committee-2026-10-31.xlsx and were reviewed by the committee.',
];

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`the pack's prose lines in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('the page model and the commentary gate never read a line short of production, in any of 300 settings', async () => {
    const cells = TEXTS.flatMap((text) => KINDS.flatMap((k) => FRACTIONS.map((f) => k.cell(text, k.style, k.mm * f))));
    const short = await shortCells(gotenberg!, cells);
    expect(short, `${short.length} of ${cells.length} settings read short`).toEqual([]);
  }, 1_800_000);

  it('nor on CJK runs of 60 to 200 characters in the matters\' columns, or tokens wider than a line (#1263 H1)', async () => {
    const runs = [CHINESE, JAPANESE].flatMap((t) => [60, 80, 120, 160, 200].map((n) => Array.from(t).slice(0, n).join('')));
    const cells: Cell[] = [
      ...runs.flatMap((t) => MATTERS_MM.map((mm) => inMattersCell(t, PROSE.mattersCell, mm))),
      inMattersCell('\u6536'.repeat(600), PROSE.mattersCell, 174),
      ...[...LONG_TOKENS, ...runs].flatMap((t) => [
        inMattersCell(t, PROSE.mattersCell, 34), inBlock('pack-narrative-body')(t, PROSE.narrativeBody, 110.7),
        inBlock('pack-narrative-body')(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3), inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, 34.8),
        inBlock('pack-footnote-text', 'span', 'line-height:11pt;')(t, PROSE.footnote, 33.6),
      ]),
    ];
    const short = await shortCells(gotenberg!, cells);
    expect(short.slice(0, 20), `${short.length} of ${cells.length} settings read short`).toEqual([]);
  }, 1_800_000);

  it('at the model\'s own boundary, and half a pixel under it, production sets no more lines than the model reads', async () => {
    // The guard (`PROSE_GUARD_PX`) is not relied on: each setting is printed at the narrowest width, to 1/64px, at which
    // the model still reads its lines, and 0.5px narrower, where the model reads one more (the blind review's L1). On
    // the faces' own text: a fallback glyph is priced by the tables, measured alone, and in a run the fallback face can
    // set one wider (katakana "\u30D0\u30F3" at 2.5% over), and a format character (ZWNJ, ZWNBSP) can shape across; both
    // are held at the guard by the settings above, not at the boundary.
    const facesOnly = (t: string): boolean => Array.from(t).every((ch) => !/\p{Cf}/u.test(ch) && PROSE_FACES.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b));
    const cells: Cell[] = [];
    const want: number[] = [];
    for (const text of [...TEXTS.filter(facesOnly), ...LONG_TOKENS]) {
      for (const k of KINDS) {
        for (const f of [0.8, 0.45]) {
          const at = (px: number): number => proseLines(text, k.style, px / MM_PX);
          const lines = at(k.mm * f * MM_PX);
          let lo = 1;
          let hi = Math.ceil(k.mm * f * MM_PX * 64);
          while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (at(mid / 64) <= lines) hi = mid; else lo = mid + 1; }
          for (const under of [0, 0.5]) { cells.push(k.cell(text, k.style, k.mm * f, lo / 64 - under)); want.push(lines); }
        }
      }
    }
    const short = await shortCells(gotenberg!, cells, (c) => want[cells.indexOf(c)]!);
    expect(short.slice(0, 20), `${short.length} of ${cells.length} settings read short`).toEqual([]);
  }, 1_800_000);
});
