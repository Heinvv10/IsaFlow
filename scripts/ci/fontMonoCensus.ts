/**
 * The logic of the font-mono census, apart from the file system (tests/unit/ci/fontMonoCensus.test.ts). An ID is
 * set in the app face with `font-id`; a monospace face is for code alone. eslint/font-mono-allowlist.json maps each
 * file that still uses `font-mono` to its count, and only shrinks, by the same rules as the raw-input list.
 */
import type { Counts, GitRunner, ListSpec } from './rawInputAllowlist';

export const FONT_MONO_LIST: ListSpec = {
  path: 'eslint/font-mono-allowlist.json',
  tag: '[font-mono-allowlist]',
  what: 'font-mono use(s)',
  fix: 'Use font-id for an ID (a monospace face is for code alone)',
  writeCommand: 'bun scripts/ci/check-font-mono-allowlist.ts --write',
};

/** The utility itself, variants included (`md:font-mono`), never a longer name (`pack-font-mono`). */
const FONT_MONO = /(?<![\w-])font-mono(?![\w-])/g;

export function countFontMono(source: string): number {
  return source.match(FONT_MONO)?.length ?? 0;
}

export function fontMonoCounts(files: string[], read: (file: string) => string): Counts {
  const counts: Counts = {};
  for (const file of files.filter((f) => /\.tsx?$/.test(f)).sort()) {
    const count = countFontMono(read(file));
    if (count > 0) counts[file] = count;
  }
  return counts;
}

export function trackedSources(git: GitRunner): string[] {
  return git(['ls-files', '--', 'pages', 'src']).split('\n').filter(Boolean);
}
