/**
 * RUNS OF THE SCRIPTS CHROMIUM BREAKS BY DICTIONARY (line-break class SA: Thai, Lao, Myanmar, Khmer and the Tai scripts),
 * so the print can break them anywhere instead (#1263 round 2). Chromium breaks such a run only between the words its
 * dictionary finds, under `overflow-wrap: normal` and `anywhere` alike, and the page model sees no break inside it: a
 * Burmese commentary the gate admitted printed page 4 a sheet long. The pack's markup sets each run in a
 * `.pack-dictionary` span (`word-break: break-all`: `PackProse`), where Chromium breaks between any two graphemes, which
 * is how the model fills a piece wider than its line (`packProseFill`), and where the run is narrower than the line, it
 * keeps it whole and Chromium breaks it sooner. Held in production's image (`printParity/packProseLinksImage.test.ts`).
 * Client-safe.
 */
import { DICTIONARY_BREAK_RANGES } from './packDictionaryBreakData';

const inDictionaryScript = (cp: number): boolean => {
  let lo = 0;
  let hi = DICTIONARY_BREAK_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = DICTIONARY_BREAK_RANGES[mid]!;
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return true;
  }
  return false;
};

export interface ProseRun { text: string; dictionary: boolean }

/** `text` as its runs, each a run of the dictionary scripts or of anything else, in order; one run where there are none. */
export function dictionaryRuns(text: string): ProseRun[] {
  const out: ProseRun[] = [];
  for (const ch of text) {
    const dictionary = inDictionaryScript(ch.codePointAt(0)!);
    const last = out[out.length - 1];
    if (last !== undefined && last.dictionary === dictionary) last.text += ch; else out.push({ text: ch, dictionary });
  }
  return out.length === 0 ? [{ text, dictionary: false }] : out;
}
