/**
 * THE PAIR TABLE AS SOURCE: a scan (`breakPairsScan.ts`) written as `packBreakPairsData.ts`, compacted without losing
 * one of the scanned 4-grams (what Chromium decides past them is not in a scan: `packNumericHold.ts`).
 * The scan reads Chromium's break for every 4-gram (context before, class A, class B, context after) as the two tables
 * and their flips; here that is folded:
 *  - contexts that break every pair alike are one group (the hundred-odd before a pair are some fifty groups, and those
 *    after fewer still);
 *  - each pair is one kind, a matrix of breaks by group before and group after, and pairs alike share it;
 *  - a kind is a row (the breaks by group after) for each group before, and kinds share the rows.
 * The source is checked back against every 4-gram before it is returned, so a table written is the scan's to the bit.
 */
import type { PairScan } from './breakPairsScan';

/** `hex` (four bits a character, the first the high one) as a bit per byte. */
function hexBits(hex: string, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = (parseInt(hex[i >> 2]!, 16) >> (3 - (i & 3))) & 1;
  return out;
}

/** Every 4-gram's break, by ((before x classes + A) x classes + B) x contexts after + after. */
function allBreaks(scan: PairScan): Uint8Array {
  const k2 = scan.classes * scan.classes;
  const left = hexBits(scan.left, scan.lefts * k2);
  const right = hexBits(scan.right, k2 * scan.rights);
  const out = new Uint8Array(scan.lefts * k2 * scan.rights);
  for (let l = 0; l < scan.lefts; l += 1) {
    for (let w = 0; w < k2; w += 1) {
      if (left[l * k2 + w] === 0) continue;
      for (let r = 0; r < scan.rights; r += 1) out[(l * k2 + w) * scan.rights + r] = right[w * scan.rights + r]!;
    }
  }
  for (const f of scan.flips) out[f] = out[f]! ^ 1;
  return out;
}

/** Each of `count` items, by `key`, as the index of the first item with its key: [group of each, firsts]. */
function grouped(count: number, key: (i: number) => string): { of: number[]; firsts: number[] } {
  const seen = new Map<string, number>();
  const firsts: number[] = [];
  const of = Array.from({ length: count }, (unused, i) => {
    const k = key(i);
    if (!seen.has(k)) { seen.set(k, firsts.length); firsts.push(i); }
    return seen.get(k)!;
  });
  return { of, firsts };
}

/** The scan, compacted: groups of contexts, a kind per pair, a row per kind and group before, the rows as bits. */
export interface PairTable {
  classes: number; lefts: number; rights: number;
  beforeGroup: number[]; afterGroup: number[]; groupsBefore: number; groupsAfter: number;
  kinds: Uint8Array; kindRows: Uint8Array; rows: Uint8Array; rowBytes: number; kindCount: number; rowCount: number;
}

/** Does `table` break between A and B (`pair` = A x classes + B), after context `l` and before `r`? */
export function tableBreaks(table: PairTable, l: number, pair: number, r: number): number {
  const row = table.kindRows[table.kinds[pair]! * table.groupsBefore + table.beforeGroup[l]!]!;
  const g = table.afterGroup[r]!;
  return (table.rows[row * table.rowBytes + (g >> 3)]! >> (7 - (g & 7))) & 1;
}

export function compactPairs(scan: PairScan): PairTable {
  const { classes, lefts, rights } = scan;
  const k2 = classes * classes;
  const all = allBreaks(scan);
  const sliceKey = (from: number, length: number, stride: number): string => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = all[from + i * stride]!;
    return Buffer.from(bytes).toString('base64');
  };
  const before = grouped(lefts, (l) => sliceKey(l * k2 * rights, k2 * rights, 1));
  const after = grouped(rights, (r) => sliceKey(r, lefts * k2, rights));
  const at = (bg: number, pair: number, ag: number): number => all[(before.firsts[bg]! * k2 + pair) * rights + after.firsts[ag]!]!;
  const rowOf = (pair: number, bg: number): string => after.firsts.map((unused, ag) => at(bg, pair, ag)).join('');
  const kinds = grouped(k2, (pair) => before.firsts.map((unused, bg) => rowOf(pair, bg)).join('|'));
  const rowKeys = new Map<string, number>();
  const rowList: string[] = [];
  const kindRows = new Uint8Array(kinds.firsts.length * before.firsts.length);
  kinds.firsts.forEach((pair, kind) => before.firsts.forEach((unused, bg) => {
    const row = rowOf(pair, bg);
    if (!rowKeys.has(row)) { rowKeys.set(row, rowList.length); rowList.push(row); }
    kindRows[kind * before.firsts.length + bg] = rowKeys.get(row)!;
  }));
  if (kinds.firsts.length > 256 || rowList.length > 256) throw new Error(`the pair table has ${kinds.firsts.length} kinds of pair and ${rowList.length} rows: more than a byte holds`);
  const rowBytes = Math.ceil(after.firsts.length / 8);
  const rows = new Uint8Array(rowList.length * rowBytes);
  rowList.forEach((row, i) => { for (let g = 0; g < row.length; g += 1) if (row[g] === '1') { const at = i * rowBytes + (g >> 3); rows[at] = rows[at]! | (1 << (7 - (g & 7))); } });
  const table: PairTable = {
    classes, lefts, rights, beforeGroup: before.of, afterGroup: after.of, groupsBefore: before.firsts.length, groupsAfter: after.firsts.length,
    kinds: Uint8Array.from(kinds.of), kindRows, rows, rowBytes, kindCount: kinds.firsts.length, rowCount: rowList.length,
  };
  for (let l = 0; l < lefts; l += 1) {
    for (let pair = 0; pair < k2; pair += 1) {
      for (let r = 0; r < rights; r += 1) {
        if (tableBreaks(table, l, pair, r) !== all[(l * k2 + pair) * rights + r]) throw new Error(`the compacted pair table misreads the 4-gram (${l}, ${pair}, ${r})`);
      }
    }
  }
  return table;
}

const chunks = (s: string, size: number): string[] => Array.from({ length: Math.ceil(s.length / size) }, (unused, i) => s.slice(i * size, (i + 1) * size));
const base64Lines = (bytes: Uint8Array): string => chunks(Buffer.from(bytes).toString('base64'), 160).map((c) => `  '${c}',`).join('\n');
const numberLines = (list: readonly number[]): string => Array.from({ length: Math.ceil(list.length / 30) }, (unused, i) => `  ${list.slice(i * 30, i * 30 + 30).join(', ')},`).join('\n');

/** `codes` with their classes, as [from, to, class] runs of consecutive code points of one class. */
function classRanges(classOf: ReadonlyMap<number, number>): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const [code, cls] of [...classOf].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === code - 1 && last[2] === cls) last[1] = code; else out.push([code, code, cls]);
  }
  return out;
}

/** The data file's source for `scan`. */
export function pairDataSource(scan: PairScan): string {
  const t = compactPairs(scan);
  const ranges = classRanges(scan.classOf);
  const items = ranges.map(([a, b, c]) => `[0x${a.toString(16)}, 0x${b.toString(16)}, ${c}]`);
  const rangeLines = Array.from({ length: Math.ceil(items.length / 8) }, (unused, i) => `  ${items.slice(i * 8, i * 8 + 8).join(', ')},`);
  return `/**
 * GENERATED in production's Gotenberg image by \`tests/unit/printParity/packBreakPairsImage.test.ts\`
 * (REGENERATE_BREAK_PAIRS=1): do not edit by hand. Read by \`packBreakPairs.ts\`, which says what it holds.
 * ${scan.classOf.size} code points in ${ranges.length} runs, ${t.classes} classes; ${t.lefts} contexts before a pair in ${t.groupsBefore} groups,
 * ${t.rights} after in ${t.groupsAfter}; ${t.kindCount} kinds of pair, ${t.rowCount} rows; ${scan.quads} 4-grams scanned.
 */
export const PAIR_CLASSES = ${t.classes};
export const PAIR_LEFTS = ${t.lefts};
export const PAIR_RIGHTS = ${t.rights};
export const PAIR_GROUPS_BEFORE = ${t.groupsBefore};
export const PAIR_GROUPS_AFTER = ${t.groupsAfter};

/** [first code point, last, class]. */
export const PAIR_CLASS_RANGES: ReadonlyArray<readonly [number, number, number]> = [
${rangeLines.join('\n')}
];

/** The group of each context before a pair, and after it. */
export const PAIR_BEFORE_GROUP: readonly number[] = [
${numberLines(t.beforeGroup)}
];
export const PAIR_AFTER_GROUP: readonly number[] = [
${numberLines(t.afterGroup)}
];

/** The kind of each pair, by A x classes + B; a byte each, base64. */
export const PAIR_KINDS = [
${base64Lines(t.kinds)}
].join('');

/** The row of each kind, by kind x groups before + group before; a byte each, base64. */
export const PAIR_KIND_ROWS = [
${base64Lines(t.kindRows)}
].join('');

/** The rows: a bit a group after (the first the high bit), ${t.rowBytes} bytes a row, base64. */
export const PAIR_ROWS = [
${base64Lines(t.rows)}
].join('');
`;
}
