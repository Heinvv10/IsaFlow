/**
 * R-176 census — a long-lived pg Pool has an 'error' listener.
 *
 * pg-pool re-emits a pooled or removed client's 'error' on the pool (index.js makeIdleListener).
 * With no listener that is an uncaught exception, which takes a server process down. So every
 * pool constructed in a tracked file in src/, pages/ and scripts/ must be assigned to a name that
 * the same function (or, at module level, the module) calls `.on('error', …)` on, or the file is
 * pinned below with the reason. A listener on a client, on another pool, or on a same-named pool
 * in another function does not count.
 *
 * Limits: a name reassigned within one function is matched by its text; a pool returned or
 * passed without a name counts as unlistened. It reads
 * `git ls-files`, so an untracked file is not seen until it is added.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const ONE_RUN = 'a one-run pool in a script, ended by that run: an uncaught pool error ends the run, which is the wanted outcome';
/** file -> pools constructed without a listener. */
const UNLISTENED: Record<string, { pools: number; reason: string }> = {
  'scripts/ap-backfill-supplier-payments.ts': { pools: 1, reason: ONE_RUN },
  'scripts/apply-migrations.ts': { pools: 1, reason: ONE_RUN },
  'scripts/audit-schema-drift.ts': { pools: 1, reason: ONE_RUN },
  'scripts/auto-apply-unapplied-dryrun.ts': { pools: 1, reason: ONE_RUN },
  'scripts/migrations/resolve-checksum-conflicts.ts': { pools: 1, reason: ONE_RUN },
  'scripts/r088-posted-receipt-key-census.ts': { pools: 1, reason: ONE_RUN },
  'scripts/test-extension-ingest.mjs': { pools: 1, reason: ONE_RUN },
};

const sources = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts'], { encoding: 'utf8' })
  .trim().split('\n').filter((f) => /\.(tsx?|mjs|cjs|js)$/.test(f));

/** The pools a file constructs, and how many of them have no `error` listener on their own name. */
function count(text: string): { pools: number; unlistened: number } {
  const names: Array<string | null> = [];
  const listened = new Set<string>();
  /** A name, qualified by the function (or module) it is used in. */
  const scoped = (n: ts.Node, name: string) => {
    let fn: ts.Node = n;
    while (!(ts.isSourceFile(fn) || ts.isFunctionLike(fn))) fn = fn.parent;
    return `${fn.pos}:${name}`;
  };
  const visit = (n: ts.Node) => {
    if (ts.isNewExpression(n)) {
      const callee = n.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'Pool') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Pool')) {
        const p = n.parent;
        names.push(ts.isVariableDeclaration(p) && p.initializer === n ? scoped(n, p.name.getText())
          : ts.isBinaryExpression(p) && p.right === n ? scoped(n, p.left.getText()) : null);
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'on'
      && n.arguments[0] !== undefined && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === 'error') {
      listened.add(scoped(n, n.expression.expression.getText()));
    }
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile('s.ts', text, ts.ScriptTarget.Latest, true));
  return { pools: names.length, unlistened: names.filter((name) => name === null || !listened.has(name)).length };
}

describe('R-176: every long-lived pool listens for errors', () => {
  it('the tracked tree was read', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toEqual(expect.arrayContaining(['src/lib/neon/pool.ts', 'scripts/_pg.ts', 'src/lib/auth/withInviteToken.ts']));
  });

  it.each([
    ["const p = new pg.Pool({}); p.on('error', log);", { pools: 1, unlistened: 0 }],
    ["_pool = new pg.Pool({}); _pool.on('error', log);", { pools: 1, unlistened: 0 }],
    ['const p = new Pool({});', { pools: 1, unlistened: 1 }],
    ["const p = new pg.Pool({}); p.on('connect', log);", { pools: 1, unlistened: 1 }],
    ["const a = new Pool({}); const b = new pg.Pool({}); a.on('error', log);", { pools: 2, unlistened: 1 }],
    // a client's listener does not cover the pool
    ["const p = new pg.Pool({}); const c = new pg.Client({}); c.on('error', log);", { pools: 1, unlistened: 1 }],
    ["const p = new pg.Pool({}); const c = await p.connect(); c.on('error', log);", { pools: 1, unlistened: 1 }],
    ["function make() { return new pg.Pool({}); } other.on('error', log);", { pools: 1, unlistened: 1 }],
    // two functions each building a pool called `pool`: one listener does not cover the other
    ["function a() { const pool = new pg.Pool({}); pool.on('error', log); } function b() { const pool = new pg.Pool({}); }", { pools: 2, unlistened: 1 }],
    ["function a() { let pool; pool = new pg.Pool({}); pool.on('error', log); }", { pools: 1, unlistened: 0 }],
  ])('counts %s', (snippet, expected) => { expect(count(snippet)).toEqual(expected); });

  it('a file that constructs a pool listens for its errors, or is pinned with the reason', () => {
    const found: Record<string, number> = {};
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('Pool(')) continue;
      const { unlistened } = count(text);
      if (unlistened > 0) found[file] = unlistened;
    }
    expect(found, "add pool.on('error', …), or pin the file in UNLISTENED with the reason an uncaught pool error is acceptable there")
      .toEqual(Object.fromEntries(Object.entries(UNLISTENED).map(([file, e]) => [file, e.pools])));
    for (const e of Object.values(UNLISTENED)) expect(e.reason.length).toBeGreaterThan(20);
  });
});
