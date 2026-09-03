/**
 * A backtick inside a SQL line comment TERMINATES the tagged template it sits
 * in.
 *
 * `sql` is a tagged template literal, so this:
 *
 *     await sql`
 *       SELECT ...
 *       -- `amount_paid` is a current snapshot
 *       WHERE ...
 *     `
 *
 * ends the template at the first backtick of the comment and leaves the rest
 * of the query as stray TypeScript. It fails at BUILD time, not at runtime, so
 * it is not dangerous — but it is invisible while writing (the comment reads
 * perfectly in a diff) and it cost three separate debugging detours in one
 * session, each time looking like an unrelated parse error several lines away.
 *
 * The rule is narrow on purpose: only `--` comments INSIDE a sql template.
 * Backticks in ordinary JSDoc above the function are fine and common.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Every tracked .ts file that uses the sql tagged template.
 *
 * execFileSync with an argument array rather than a shell string: no shell, so
 * nothing here can be interpreted as a metacharacter. `git grep` exits 1 when
 * it matches nothing, which is not an error for us.
 */
function filesUsingSqlTemplate(): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-l', 'sql`', '--', 'src/**/*.ts', 'pages/**/*.ts'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Line numbers of `--` comments containing a backtick OR a `${...}`
 * interpolation, restricted to lines between a sql template opening and its
 * closing backtick.
 *
 * The interpolation case is the same family and just as invisible: a `${x}`
 * inside a SQL comment still becomes a bind parameter, but it sits in
 * commented-out text where Postgres can never see it used. The query then
 * fails at RUNTIME with 42P18 "could not determine data type of parameter $1",
 * naming a parameter that looks nothing like the comment that caused it.
 */
function offendingLines(source: string): number[] {
  const lines = source.split('\n');
  const bad: number[] = [];
  let inTemplate = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (!inTemplate) {
      // Opens a sql template and does not close on the same line.
      if (/\bsql`/.test(line) && (line.match(/`/g) ?? []).length === 1) {
        inTemplate = true;
      }
      continue;
    }

    if (line.trimStart().startsWith('--') && (line.includes('`') || line.includes('${'))) {
      bad.push(i + 1);
      continue;
    }
    if (line.includes('`')) inTemplate = false;
  }
  return bad;
}

describe('no backtick or interpolation inside a SQL comment in a tagged template', () => {
  it('every sql template is free of them', () => {
    const files = filesUsingSqlTemplate();

    // Without this the whole test is vacuous: a broken discovery returns [],
    // finds nothing, and stays green for ever.
    expect(files.length, 'no files using the sql template were found').toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = offendingLines(readFileSync(file, 'utf8'));
      for (const line of lines) offenders.push(`${file}:${line}`);
    }

    expect(
      offenders,
      `a backtick in a SQL comment ends the template early:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('detects the shape it is meant to detect', () => {
    // Guards the detector itself: without this, a bug that makes
    // offendingLines always return [] would leave the test permanently green.
    const bad = [
      'const x = await sql`',
      '  SELECT 1',
      '  -- `amount_paid` is a snapshot',
      '`;',
    ].join('\n');
    expect(offendingLines(bad)).toEqual([3]);

    // An interpolation in a comment becomes a bind parameter nothing uses,
    // and the query dies at runtime with 42P18 rather than at build time.
    const interpolated = [
      'const x = await sql`',
      '  SELECT 1',
      '  -- bounded by ${todayStr}::date',
      '`;',
    ].join('\n');
    expect(offendingLines(interpolated)).toEqual([3]);

    const good = [
      'const x = await sql`',
      '  SELECT 1',
      '  -- amount_paid is a snapshot, bounded by the today value',
      '`;',
    ].join('\n');
    expect(offendingLines(good)).toEqual([]);
  });
});
