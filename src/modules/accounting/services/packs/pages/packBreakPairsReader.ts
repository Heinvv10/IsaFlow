/**
 * THE PAIR TABLE READ BACK: the generated data (`packBreakPairsData.ts`, written by
 * `tests/unit/printParity/breakPairsTable.pairDataSource`) as a function of context before, pair and context after.
 * Split from `packBreakPairs.ts` so a synthetic table can be read the way production reads its own
 * (`tests/unit/printParity/breakPairsTable.test.ts`).
 */

/** What the data file holds: the counts, the groups of contexts, and the kinds, kind rows and rows as base64. */
export interface PairTableData {
  classes: number; lefts: number; rights: number; groupsBefore: number; groupsAfter: number;
  beforeGroup: readonly number[]; afterGroup: readonly number[]; kinds: string; kindRows: string; rows: string;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** `base64` as its bytes (no Buffer: the pack's modules run in the browser too). */
export function bytesOf(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of clean) {
    acc = (acc << 6) | BASE64.indexOf(c);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[at] = (acc >> bits) & 0xff; at += 1; }
  }
  return out;
}

/**
 * `data` as `(before, a, b, after) => breaks?`, `a` and `b` classes and `before`/`after` contexts (`packBreakPairs.BEFORE`,
 * `AFTER`, `contextOf`). Each lookup is three bytes and a bit. Throws where the data's parts do not fit each other.
 */
export function pairTableReader(data: PairTableData, specials: number): (before: number, a: number, b: number, after: number) => boolean {
  const kind = bytesOf(data.kinds);
  const kindRow = bytesOf(data.kindRows);
  const rows = bytesOf(data.rows);
  const rowBytes = Math.ceil(data.groupsAfter / 8);
  if (data.lefts !== specials + data.classes || data.rights !== specials + data.classes
    || data.beforeGroup.length !== data.lefts || data.afterGroup.length !== data.rights || kind.length !== data.classes * data.classes) {
    throw new Error(`packBreakPairs: the table's contexts (${data.lefts}, ${data.rights}) or kinds (${kind.length}) do not fit its ${data.classes} classes`);
  }
  return (before, a, b, after) => {
    const row = kindRow[kind[a * data.classes + b]! * data.groupsBefore + data.beforeGroup[before]!]!;
    const g = data.afterGroup[after]!;
    return ((rows[row * rowBytes + (g >> 3)]! >> (7 - (g & 7))) & 1) === 1;
  };
}
