/**
 * RUNS OF THE SCRIPTS CHROMIUM BREAKS BY DICTIONARY (line-break class SA: Thai, Lao, Myanmar, Khmer and the Tai scripts),
 * so the print can break them anywhere instead (#1263 round 2). Chromium breaks such a run only between the words its
 * dictionary finds, under `overflow-wrap: normal` and `anywhere` alike, and the page model sees no break inside it: a
 * Burmese commentary the gate admitted printed page 4 a sheet long. The pack's markup sets each run in a
 * `.pack-dictionary` span (`word-break: break-all`: `PackProse`), where Chromium breaks between any two graphemes, and
 * `packLineBreaks.pieces` breaks between two of its clusters too. At a run's edge the rules hold what is glued to it (a
 * Latin word stays whole: #1263 round 3). Held in production's image (`printParity/packProseDictionaryImage.test.ts`).
 * Client-safe.
 */
import { DICTIONARY_BREAK_RANGES } from './packDictionaryBreakData';
import { graphemes } from './packGraphemes';

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

/** Is `cluster` (a grapheme cluster) of a dictionary script: is its base, its first code point? */
export const isDictionaryCluster = (cluster: string): boolean => inDictionaryScript(cluster.codePointAt(0)!);

/**
 * `text` as its runs, each a run of the dictionary scripts or of anything else, in order; one run where there are none.
 * Split between grapheme clusters only, a cluster going with its base (#1263 round 3: "m" with a Myanmar vowel sign split
 * across the span's edge was shaped as a base and a lone mark, far wider than either).
 */
export function dictionaryRuns(text: string): ProseRun[] {
  const out: ProseRun[] = [];
  for (const { segment } of graphemes(text)) {
    const dictionary = isDictionaryCluster(segment);
    const last = out[out.length - 1];
    if (last !== undefined && last.dictionary === dictionary) last.text += segment; else out.push({ text: segment, dictionary });
  }
  return out.length === 0 ? [{ text, dictionary: false }] : out;
}
