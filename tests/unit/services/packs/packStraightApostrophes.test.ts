/**
 * ONE APOSTROPHE, AND IT IS THE STRAIGHT ONE.
 *
 * Page 8 printed "the prior period’s closing balance" and "this pack’s figure
 * set" in curly apostrophes, three of them, on a sheet carrying forty-eight
 * straight ones — `R'000` in its own axis title among them. Two glyphs for
 * one mark in one paragraph is the kind of thing a director notices and a
 * spell-check does not.
 *
 * THIS IS A LINTER AND IS MEANT TO BE. The rule is about the prose this
 * repository AUTHORS, not about the document a company's data composes into:
 * a customer legitimately called O’Brien must be printed as they spell it, so
 * a scan of the rendered pack would have to know which strings are ours. The
 * source does know. Scoped to the pack's own modules and to the apostrophe
 * alone — the curly double quotes are not used anywhere here and banning
 * glyphs nothing writes is a guard that can only ever fire on a false
 * positive.
 *
 * The escaping cost is the reason the curly ones appeared: a straight
 * apostrophe closes a single-quoted TypeScript string. `\'` is the answer,
 * not a different glyph.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/modules/accounting/services/packs';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

describe("the pack's own prose uses the straight apostrophe", () => {
  it('carries no curly apostrophe in any pack module', () => {
    const files = sources(ROOT);
    // NOT VACUOUS: the walk has to have found the modules that print prose.
    expect(files.length, 'no pack sources found, so nothing is scanned').toBeGreaterThan(20);
    expect(files, 'the module that printed the curly ones is not being scanned')
      .toContain(join(ROOT, 'pages', 'packPageCharts.ts'));

    const offenders = files.flatMap((file) => {
      const lines = readFileSync(file, 'utf8').split('\n');
      return lines
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter((row) => row.text.includes('’'));
    });
    expect(
      offenders.map((o) => `${o.file}:${o.line} ${o.text.trim().slice(0, 80)}`),
      'a curly apostrophe in pack prose — escape the straight one as \\\' instead',
    ).toEqual([]);
  });
});
