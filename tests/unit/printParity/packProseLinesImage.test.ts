/**
 * THE PROSE MODEL NEVER READS A LINE SHORT OF PRODUCTION'S, IN PRODUCTION'S IMAGE (the prose PR, Hein 11-10).
 * `packProseLines.proseLines` sets each word at the faces' widths and a character the faces lack from the fallback
 * tables; `packProseBound.proseLinesBound`, the commentary gate's, at the generated upper bound. Both are held here
 * against Gotenberg's Chromium on the pack's own prose rules (a disclosure's body, page 4's commentary, a footnote) at
 * four measures, on the scripts and spaces the em table mispriced: CJK, set spaces, U+2007 and ZWNBSP inside a word, "%"
 * "@" "&", long words. The CI Chromium's fallback faces are not production's, so this text is held only here
 * (`tests/unit/print/packTextMetrics.test.ts` holds the faces' text there).
 *
 * Not held: a joined script in a fallback face (Syriac SADHE is 7.52px alone, about 10.3px joined, and 80 of them read a
 * line short): the KNOWN LIMIT `packProseLines` records, reached by no fixture. Velo only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_WIDTH_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import { PROSE, type ProseStyle } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';

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

interface Kind { cls: string; tag: string; style: ProseStyle; mm: number; leading: string }
const W = PAGE_WIDTH_MM.portrait;
const KINDS: readonly Kind[] = [
  { cls: 'pack-disclosure-body', tag: 'p', style: PROSE.disclosureBody, mm: W, leading: '' },
  { cls: 'pack-narrative-body', tag: 'div', style: PROSE.narrativeBody, mm: W, leading: '' },
  { cls: 'pack-footnote-text', tag: 'span', style: PROSE.footnote, mm: W - 6, leading: 'line-height:11pt;' },
];
const FRACTIONS = [1, 0.8, 0.6, 0.45];

/** Each case's lines as production sets them: the distinct tops of its text's line boxes. */
const LINES_SCRIPT = `function answer() { return Array.from(document.querySelectorAll('.case .m')).map(function (m) {
  var r = document.createRange(); r.selectNodeContents(m); var tops = {};
  Array.from(r.getClientRects()).forEach(function (x) { if (x.width > 0) tops[Math.round(x.top)] = 1; });
  return 'N|' + Object.keys(tops).length; }); }`;

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`the pack's prose lines in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('the page model and the commentary gate never read a line short of production, in any of 300 settings', async () => {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const cases = TEXTS.flatMap((text) => KINDS.flatMap((kind) => FRACTIONS.map((f) => ({ text, kind, mm: kind.mm * f }))));
    const html = cases.map(({ text, kind, mm }) => `<div class="case" style="font-family:var(--pack-font-sans)"><${kind.tag} class="${kind.cls} m" `
      + `style="display:block;width:${(mm * 96) / 25.4}px;font-size:${kind.style.pt}pt;${kind.leading}">${esc(text)}</${kind.tag}></div>`).join('');
    const got = (await inImage(gotenberg!, LINES_SCRIPT, `<div class="pack-pages"><div class="pack-page">${html}</div></div>`))
      .filter((l) => l.startsWith('N|')).map((l) => Number(l.slice(2)));
    expect(got.length, 'the image\'s line counts came back incomplete').toBe(cases.length);
    const short: string[] = [];
    cases.forEach(({ text, kind, mm }, i) => {
      const at = `${kind.cls} ${mm.toFixed(1)}mm ${JSON.stringify(text).slice(0, 40)}: production ${got[i]}`;
      const model = proseLines(text, kind.style, mm);
      if (model < got[i]!) short.push(`${at}, model ${model}`);
      if (kind.style.weight === 400 && proseLinesBound(text, kind.style, mm) < got[i]!) short.push(`${at}, bound ${proseLinesBound(text, kind.style, mm)}`);
    });
    expect(short, `${short.length} of ${cases.length} settings read short`).toEqual([]);
  }, 1_800_000);
});
