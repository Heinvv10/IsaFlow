/**
 * THE CHARACTERS THE PAIR TABLE COVERS (`packBreakPairs.ts`):
 *  - every code point all three of the pack's faces set, and every other assigned one to U+30FF (set from a fallback
 *    face), but the ones the splitter decides otherwise: the collapsible space (a word ends there), controls, the soft
 *    hyphen, the zero-width space and the joiners (`packSoftBreakRanges.ts`; nothing breaks after a joiner), combining
 *    marks (they go with the character before them), the line and paragraph separators (a line always ends after one)
 *    and private use. The letters of the scripts Chromium breaks by dictionary, not by pair (Thai, Lao, Khmer, Myanmar,
 *    Balinese, ...), are left out, as `packBreakRanges.ts` leaves them; their digits and signs are in;
 *  - one of each uniform kind past U+30FF, an ideograph, a Hangul syllable, a full-width letter and a private-use
 *    character: a code point of that kind the table lacks is read as it (`packBreakPairs.SCRIPT_STAND_INS`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { SCRIPT_STAND_INS } from '@/modules/accounting/services/packs/pages/packBreakPairs';

const FILES = ['IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2'];
const DECIDED_ELSEWHERE = /[\p{Cc}\p{M}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}\u00AD\u200B\u200C\u200D\uFEFF]/u;
/** The letters Chromium breaks by dictionary: those of the scripts `packBreakRanges.ts` lists (their signs are paired). */
const BY_DICTIONARY = /(?=\p{L})[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Balinese}\p{Script=Batak}\p{Script=Javanese}\p{Script=Sundanese}\p{Script=Cham}\p{Script=Tai_Le}\p{Script=New_Tai_Lue}\p{Script=Tai_Tham}\p{Script=Tai_Viet}]/u;

export function PAIR_DOMAIN(): number[] {
  const sets = FILES.map((f) => new Set(fontkit.create(readFileSync(path.join(process.cwd(), 'public/fonts', f))).characterSet));
  // A noncharacter the faces set (U+FFFF) is in: a tenant can type it, and Chromium breaks beside it.
  const inFaces = (c: number): boolean => !DECIDED_ELSEWHERE.test(String.fromCodePoint(c)) || /^\p{Cn}$/u.test(String.fromCodePoint(c));
  const out = new Set<number>([...sets[0]!].filter((c) => sets.every((s) => s.has(c)) && c !== 0x20 && c < 0x10000 && inFaces(c)));
  for (let c = 0x21; c < 0x3100; c += 1) {
    const s = String.fromCodePoint(c);
    if (!DECIDED_ELSEWHERE.test(s) && !BY_DICTIONARY.test(s)) out.add(c);
  }
  for (const c of Object.values(SCRIPT_STAND_INS)) out.add(c);
  return [...out].sort((a, b) => a - b);
}

/** One code point of each class the committed table holds, and the stand-ins: where a new scan starts. */
export function seedOf(ranges: ReadonlyArray<readonly [number, number, number]>): number[] {
  const first = new Map<number, number>();
  for (const [from, , cls] of ranges) if (!first.has(cls) || from < first.get(cls)!) first.set(cls, from);
  return [...new Set([...first.values(), ...Object.values(SCRIPT_STAND_INS)])];
}
