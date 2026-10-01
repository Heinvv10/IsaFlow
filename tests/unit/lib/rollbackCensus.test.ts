/**
 * R-176 census — nothing sends a bare ROLLBACK.
 *
 * The release census (releaseCensus.test.ts) sees only `.release(`, so a transaction owner on a
 * dedicated pg.Client, which ends its client instead of releasing it, was invisible to it. Such
 * an owner cannot pool a dirty connection, but a bare ROLLBACK there still waits without bound,
 * sends no cancel, and when it fails it throws over the error that caused it. So every
 * `.query('ROLLBACK')` in src/, pages/, scripts/, middleware.ts and instrumentation.ts must be
 * the one inside rollbackFailed.ts, or be pinned below with the reason.
 *
 * Reads the tracked tree (git ls-files) and fails closed: a new bare ROLLBACK, an extra one in a
 * pinned file, or a pinned one that is gone, all turn this red.
 *
 * Limits: a ROLLBACK whose text is held in a variable or built at run time, or sent through
 * something other than `.query(`, is not seen. `ROLLBACK TO SAVEPOINT` is not a ROLLBACK of the
 * transaction and is not counted.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const HELPER_FILE = 'src/lib/rollbackFailed.ts';
const IN_A_HELPER = 'a migration tool whose ROLLBACK sits in a helper and whose release is in main, on a pool ended with the run (R-176 fix.md)';
const PINNED: Record<string, { count: number; reason: string }> = {
  [HELPER_FILE]: { count: 1, reason: 'the one ROLLBACK every owner goes through: bounded, logged, cancels the backend' },
  'scripts/apply-migrations.ts': { count: 1, reason: IN_A_HELPER },
  'scripts/migrations/resolve-checksum-conflicts.ts': { count: 1, reason: IN_A_HELPER },
};

const sources = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts', 'middleware.ts', 'instrumentation.ts'],
  { encoding: 'utf8' }).trim().split('\n').filter((f) => /\.(tsx?|mjs|cjs|js)$/.test(f));

const isRollback = (a: ts.Expression | undefined) => a !== undefined
  && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
  && /^\s*ROLLBACK\s*;?\s*$/i.test(a.text);

function bareRollbacks(text: string): number {
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'query' && isRollback(node.arguments[0])) n += 1;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('s.ts', text, ts.ScriptTarget.Latest, true));
  return n;
}

describe('R-176: no bare ROLLBACK', () => {
  it('the tracked tree was read', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toEqual(expect.arrayContaining([HELPER_FILE, 'scripts/fixes/backfill-je-fiscal-periods.ts']));
  });

  it.each(["await c.query('ROLLBACK');", 'await c.query("rollback");', 'await c.query(`ROLLBACK`);', "c.query('ROLLBACK;')",
    "await client.query(' ROLLBACK ').catch(() => undefined);", "(async () => client.query('ROLLBACK'))()"])(
    'counts %s', (snippet) => { expect(bareRollbacks(snippet)).toBe(1); });

  it.each(["await c.query('ROLLBACK TO SAVEPOINT sp1');", "await c.query('SELECT 1');", "await rollbackFailed(c, 'x');",
    "log.info('ROLLBACK');", "await c.query('COMMIT');"])(
    'does not count %s', (snippet) => { expect(bareRollbacks(snippet)).toBe(0); });

  it('every bare ROLLBACK is a pinned one', () => {
    const found: Record<string, number> = {};
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (!/rollback/i.test(text)) continue;
      const n = bareRollbacks(text);
      if (n > 0) found[file] = n;
    }
    expect(found, "roll back with rollbackFailed(client, source), or pin the file in PINNED with the reason")
      .toEqual(Object.fromEntries(Object.entries(PINNED).map(([file, e]) => [file, e.count])));
    for (const e of Object.values(PINNED)) expect(e.reason.length).toBeGreaterThan(20);
  });
});
