/**
 * R-176 census — a pooled connection is never released bare by a transaction owner.
 *
 * pg-pool destroys a client only when it is released with a truthy argument (or its socket is
 * already dead). An owner whose ROLLBACK failed and that then calls `client.release()` pools a
 * live connection still inside its transaction. So every `.release(` in src/, pages/, scripts/,
 * middleware.ts and instrumentation.ts must pass an argument (the result of rollbackFailed), or
 * be listed in BARE below with the reason it is safe.
 *
 * Reads the tracked tree (git ls-files) and fails closed: a new bare release anywhere, an extra
 * one in a listed file, or a listed one that is gone, all turn this red. BARE pins each file's
 * bare calls by their exact text, in source order.
 *
 * Named limit: a release reached through an alias (`const done = client.release; done()`) or a
 * key held in a variable is not resolvable from the syntax tree. Review is the guard for that.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const PER_RUN_POOL = 'the pool is built for this one run and ended in the same finally, so nothing can check this connection out again';
const BARE: Record<string, { calls: string[]; reason: string }> = {
  'pages/api/auth/verify-email.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'scripts/ap-backfill-supplier-payments.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'scripts/apply-migrations.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'scripts/auto-apply-unapplied-dryrun.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'scripts/migrations/resolve-checksum-conflicts.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'scripts/r088-posted-receipt-key-census.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'src/modules/accounting/services/ar/sentMirrorService.ts': {
    calls: ['lock.release()'], reason: 'an IMAP mailbox lock, not a Postgres client',
  },
  'src/modules/accounting/services/capture/imapMirrorService.ts': {
    calls: ['lock.release()'], reason: 'an IMAP mailbox lock, not a Postgres client',
  },
};

const sources = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts', 'middleware.ts', 'instrumentation.ts'],
  { encoding: 'utf8' }).trim().split('\n').filter((f) => /\.(tsx?|mjs|cjs|js)$/.test(f));

const isRelease = (callee: ts.Expression) =>
  (ts.isPropertyAccessExpression(callee) && callee.name.text === 'release')
  || (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
    && callee.argumentExpression.text === 'release');
/** An argument that cannot be truthy keeps the connection, exactly as no argument does. */
const neverTruthy = (a: ts.Expression) => a.kind === ts.SyntaxKind.FalseKeyword || a.kind === ts.SyntaxKind.NullKeyword
  || (ts.isIdentifier(a) && a.text === 'undefined') || (ts.isNumericLiteral(a) && Number(a.text) === 0);

function bareReleases(file: string, text: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && isRelease(n.expression) && n.arguments.every(neverTruthy)) out.push(n.getText());
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return out;
}
const flags = (snippet: string) => bareReleases('s.ts', snippet).length > 0;

describe('R-176: no transaction owner releases its connection bare', () => {
  it('the tracked tree was read', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toEqual(expect.arrayContaining(['src/lib/auth/withAuth.ts', 'src/lib/neon.ts', 'scripts/_pg.ts',
      'pages/api/auth/verify-email.ts', 'middleware.ts', 'instrumentation.ts']));
  });

  it.each(['client.release();', 'txClient.release();', "client['release']();", 'client.release(undefined);',
    'client.release(false);', 'client.release(null);', 'client.release(0);', 'a.b.client.release();'])(
    'the matcher flags %s', (snippet) => { expect(flags(snippet)).toBe(true); });

  it.each(['client.release(unusable);', 'client.release(true);', 'client.release(err);',
    'client.release(poisoned ? new Error() : undefined);', 'release();', 'client.releaseAll();', 'const release = 1;'])(
    'the matcher leaves %s alone', (snippet) => { expect(flags(snippet)).toBe(false); });

  it('every bare release is one of the pinned ones', () => {
    const found: Record<string, string[]> = {};
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('release')) continue;
      const calls = bareReleases(file, text);
      if (calls.length > 0) found[file] = calls;
    }
    expect(found, 'a bare .release(): release with the result of rollbackFailed(), or pin it in BARE with the '
      + 'reason no later caller can receive that connection')
      .toEqual(Object.fromEntries(Object.entries(BARE).map(([file, entry]) => [file, entry.calls])));
  });

  it('every pinned entry says why', () => {
    for (const entry of Object.values(BARE)) expect(entry.reason.length).toBeGreaterThan(20);
  });
});
