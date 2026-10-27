/**
 * Two `dark:text-<color>-<n>` utilities in one class string: Tailwind's stylesheet order, not the written order,
 * decides which wins, and the dimmer one (e.g. `dark:text-gray-400 dark:text-gray-500`) failed AA contrast in the
 * dark "?" overlay. Reads `git ls-files`, so an untracked file is not a hole.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const DARK_TEXT = /(?<![:\w-])dark:text-(?:[a-z]+-\d+|white|black|\[[^\]]+\])/g;
const STRING_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;

/** Class strings in `source`: each quoted literal, and a template's static text apart from its `${}` branches. */
function classStrings(source: string): string[] {
  return (source.match(STRING_LITERAL) ?? []).flatMap((lit) => {
    if (!lit.startsWith('`')) return [lit];
    const inner = lit.match(/\$\{[\s\S]*?\}/g) ?? [];
    return [lit.replace(/\$\{[\s\S]*?\}/g, ' '), ...inner.flatMap((e) => e.match(STRING_LITERAL) ?? [])];
  });
}

/** Strings in `source` that carry two or more dark:text color utilities. */
export function duplicateDarkText(source: string): string[] {
  return classStrings(source).filter((s) => (s.match(DARK_TEXT) ?? []).length > 1);
}

describe('duplicate dark:text-* census', () => {
  it('detects a duplicate and ignores a single or a differently-prefixed pair', () => {
    expect(duplicateDarkText('<p className="text-sm dark:text-gray-400 dark:text-gray-500">')).toHaveLength(1);
    expect(duplicateDarkText('<p className="dark:text-gray-400 hover:dark:text-gray-200">')).toHaveLength(0);
    expect(duplicateDarkText('<p className="dark:text-gray-400">')).toHaveLength(0);
    expect(duplicateDarkText('<p className="dark:text-white dark:text-slate-900">')).toHaveLength(1);
    expect(duplicateDarkText('<p className="dark:text-black dark:text-[#123]">')).toHaveLength(1);
    expect(duplicateDarkText("`x ${a ? 'dark:text-red-400' : 'dark:text-green-400'}`")).toHaveLength(0);
    expect(duplicateDarkText("`dark:text-gray-400 ${a} dark:text-gray-500`")).toHaveLength(1);
  });

  it('no tracked source file has two dark:text colors in one class string', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.css', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter((f) => f && !f.startsWith('tests/'));
    const offenders = files.flatMap((f) => duplicateDarkText(readFileSync(path.join(ROOT, f), 'utf8')).map((s) => `${f}: ${s.trim().slice(0, 100)}`));
    expect(offenders).toEqual([]);
  });
});
