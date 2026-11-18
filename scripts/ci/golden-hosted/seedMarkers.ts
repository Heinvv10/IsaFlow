/**
 * The names the hosted seed gives its records, and the progress of a seed that stopped half way. One module so the seeders
 * that write the markers and the queries that find them (scripts/deploy/verifyCompany) cannot drift apart: each marker has a
 * builder (what the seeder writes) and a pattern (what a query matches; capture 1 is the index).
 */

export interface Marker {
  build: (n: number) => string;
  /** A POSIX regex for Postgres (`~`, `regexp_match`) and for JavaScript. */
  pattern: string;
}

const marker = (prefix: string, suffix = ''): Marker => ({
  build: (n) => `${prefix}${n}${suffix}`,
  pattern: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9]+)${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
});

export const MARK = {
  customer: marker('Demo Customer '),
  supplier: marker('Demo Supplier '),
  apInvoice: marker('DEMO-AP-'),
  arNote: marker('DEMO-AR-'),
  journal: marker('DEMO-JNL-'),
  /** A bank statement row's description: the index, then the words the amount's sign picks. */
  bank: {
    build: (n: number, credit = false) => `DEMO-BNK ${n} ${credit ? 'customer deposit' : 'supplies'}`,
    pattern: '^DEMO-BNK ([0-9]+) (customer deposit|supplies)$',
  },
} as const;

/** The index a marker holds in `text`, or null when the text is not that marker. */
export function markerIndex(m: Marker, text: string): number | null {
  const hit = new RegExp(m.pattern).exec(text);
  return hit ? Number(hit[1]) : null;
}

/**
 * Where a seed of records numbered 1..n stands. `ids` holds every record that exists (index -> id); `done` those that are
 * complete (approved, posted). A record that exists and is not done is finished, never made again; one that is absent is made.
 */
export interface Progress {
  ids: ReadonlyMap<number, string>;
  done: ReadonlySet<number>;
}

export const NOTHING: Progress = { ids: new Map(), done: new Set() };

/** The indices 1..n a progress does not hold at all. */
export const missing = (n: number, p: Progress): number[] =>
  Array.from({ length: n }, (_, i) => i + 1).filter((i) => !p.ids.has(i));

/** True when every record 1..n exists and is done. */
export const complete = (n: number, p: Progress): boolean =>
  Array.from({ length: n }, (_, i) => i + 1).every((i) => p.ids.has(i) && p.done.has(i));
