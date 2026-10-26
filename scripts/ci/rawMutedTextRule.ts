/**
 * Raw muted-text stops: `text-gray-400/500`, `text-slate-400/500` (and zinc/neutral/stone).
 *
 * Those stops are dark-first greys: 2.5-3.5:1 on a white page. styles/themeContrast.css remaps
 * them in the light theme, but that file is a stopgap (Wave 1: migrate call sites to the ink-*
 * tokens - text-ink-muted / text-ink-faint - and delete it). This rule lets the number only fall.
 *
 * Counted: the bare token, a responsive form (`sm:text-slate-500`) and an opacity form
 * (`text-slate-500/80`; themeContrast.css cannot remap those, so they are the worst offenders).
 * Not counted: `dark:text-slate-400` and `hover:text-slate-500`, which carry a theme or state variant
 * and are the intended way to write a dark-theme grey.
 */
export const RAW_MUTED_TEXT_STOP = /(?<![\w:-])(?:(?:sm|md|lg|xl|2xl):)*text-(?:gray|slate|zinc|neutral|stone)-(?:400|500)(?![\w-])(?:\/\d+)?/g;

export function countRawMutedTextStops(src: string): number {
  return src.match(RAW_MUTED_TEXT_STOP)?.length ?? 0;
}

export type Baseline = Record<string, number>;

export interface Verdict {
  /** Files that have more raw stops than their baseline (or any, when not listed). */
  grew: string[];
  /** Files whose count fell: lower the baseline so the gain cannot be spent again. */
  shrank: string[];
}

export function judge(counts: Baseline, baseline: Baseline): Verdict {
  const files = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
  const grew: string[] = [];
  const shrank: string[] = [];
  for (const f of [...files].sort()) {
    const now = counts[f] ?? 0;
    const allowed = baseline[f] ?? 0;
    if (now > allowed) grew.push(allowed === 0 ? `${f}: ${now} raw stop(s) in a file with none allowed` : `${f}: ${now} raw stops, ${allowed} allowed`);
    else if (now < allowed) shrank.push(`${f}: ${now} raw stops, baseline still says ${allowed}`);
  }
  return { grew, shrank };
}
