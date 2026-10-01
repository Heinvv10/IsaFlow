/**
 * R-176 census — a long-lived pg Pool has an 'error' listener.
 *
 * pg-pool re-emits a pooled or removed client's 'error' on the pool (index.js makeIdleListener).
 * With no listener that is an uncaught exception, which takes a server process down. So every
 * tracked file in src/, pages/ and scripts/ that constructs a Pool must register at least as
 * many `.on('error', …)` listeners as it constructs pools, or be pinned below with the reason.
 *
 * Limits: it counts within one file, so a pool built in one file and listened to in another is
 * reported, and a listener on something that is not the pool is counted. It reads
 * `git ls-files`, so an untracked file is not seen until it is added.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const ONE_RUN = 'a one-run pool in a script or a single request, ended by that run: an uncaught pool error ends the run, which is the wanted outcome';
/** file -> pools constructed without a listener. */
const UNLISTENED: Record<string, { pools: number; reason: string }> = {
  'pages/api/auth/verify-email.ts': { pools: 1, reason: ONE_RUN },
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

function count(text: string): { pools: number; listeners: number } {
  let pools = 0;
  let listeners = 0;
  const visit = (n: ts.Node) => {
    if (ts.isNewExpression(n)) {
      const callee = n.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'Pool') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Pool')) pools += 1;
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'on'
      && n.arguments[0] !== undefined && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === 'error') listeners += 1;
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile('s.ts', text, ts.ScriptTarget.Latest, true));
  return { pools, listeners };
}

describe('R-176: every long-lived pool listens for errors', () => {
  it('the tracked tree was read', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toEqual(expect.arrayContaining(['src/lib/neon.ts', 'scripts/_pg.ts', 'src/lib/auth/withInviteToken.ts']));
  });

  it.each([
    ["const p = new pg.Pool({}); p.on('error', log);", { pools: 1, listeners: 1 }],
    ['const p = new Pool({});', { pools: 1, listeners: 0 }],
    ["const p = new pg.Pool({}); p.on('connect', log);", { pools: 1, listeners: 0 }],
    ["const a = new Pool({}); const b = new pg.Pool({}); a.on('error', log);", { pools: 2, listeners: 1 }],
    ["const c = new pg.Client({}); c.on('error', log);", { pools: 0, listeners: 1 }],
  ])('counts %s', (snippet, expected) => { expect(count(snippet)).toEqual(expected); });

  it('a file that constructs a pool listens for its errors, or is pinned with the reason', () => {
    const found: Record<string, number> = {};
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('Pool(')) continue;
      const { pools, listeners } = count(text);
      if (pools > listeners) found[file] = pools - listeners;
    }
    expect(found, "add pool.on('error', …), or pin the file in UNLISTENED with the reason an uncaught pool error is acceptable there")
      .toEqual(Object.fromEntries(Object.entries(UNLISTENED).map(([file, e]) => [file, e.pools])));
    for (const e of Object.values(UNLISTENED)) expect(e.reason.length).toBeGreaterThan(20);
  });
});
