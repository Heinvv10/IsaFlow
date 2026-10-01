/**
 * R-176 census — a pooled connection is never released bare by a transaction owner.
 *
 * pg-pool destroys a client only when it is released with a truthy argument (or its socket is
 * already dead). An owner whose ROLLBACK failed and that then calls `client.release()` pools a
 * live connection still inside its transaction. So, for every `.release` in src/, pages/,
 * scripts/, middleware.ts and instrumentation.ts:
 *   1. a call whose argument can never be truthy (none, or a constant-falsy one) is BARE and must
 *      be pinned below, by its exact text, with the reason no later caller can get that connection;
 *   2. a per-run-pool pin must end its pool in the same `finally` as the release;
 *   3. any other call must release with a value that, in the same function, is (or is assigned
 *      from) a `rollbackFailed(` / `rollbackError(` result for THAT client, or an error caught
 *      around a query on it;
 *   4. `.release` reached any other way (`.call`, `.apply`, `.bind`, a spread argument, an alias,
 *      destructuring) fails closed.
 *
 * Limits, by design of a syntax check:
 *   - it reads `git ls-files`, so an untracked file is not seen until it is added;
 *   - a key held in a variable (`client[k]()`), or a client handed to another function that
 *     releases it, is not resolvable here;
 *   - rule 3 proves the value is derived from the ROLLBACK's outcome, not that every path
 *     assigns it. The integration suites (r176-*.int.test.ts) are the proof of behaviour.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const PER_RUN_POOL = 'a migration tool whose pool is built for this one run and ended in the same finally, so nothing outside the run can check this connection out again; its ROLLBACK sits in a helper the release cannot see (see R-176 fix.md)';
const IMAP_LOCK = 'an IMAP mailbox lock, not a Postgres client';
const RUNS_ON_IMPORT = 'two ROLLBACK paths (dry run and catch) whose results this census cannot tell apart, in a script no test can drive, so a conversion could not be proved. Its pool is built for the run and ended in the same finally (R-176 fix.md)';
const BARE: Record<string, { calls: string[]; reason: string }> = {
  'scripts/ap-backfill-supplier-payments.ts': { calls: ['client.release()'], reason: RUNS_ON_IMPORT },
  'scripts/apply-migrations.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'scripts/migrations/resolve-checksum-conflicts.ts': { calls: ['client.release()'], reason: PER_RUN_POOL },
  'src/modules/accounting/services/ar/sentMirrorService.ts': { calls: ['lock.release()'], reason: IMAP_LOCK },
  'src/modules/accounting/services/capture/imapMirrorService.ts': { calls: ['lock.release()'], reason: IMAP_LOCK },
};

const sources = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts', 'middleware.ts', 'instrumentation.ts'],
  { encoding: 'utf8' }).trim().split('\n').filter((f) => /\.(tsx?|mjs|cjs|js)$/.test(f));

type Kind = 'bare' | 'unproven' | 'indirect';
interface Finding { kind: Kind; text: string; node: ts.Node }

const find = (root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => { if (pred(n)) out.push(n); ts.forEachChild(n, visit); };
  visit(root);
  return out;
};
const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
const isReleaseRef = (n: ts.Node) => (ts.isPropertyAccessExpression(n) && n.name.text === 'release')
  || (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'release');
const constantTruthy = (e: ts.Expression): boolean => {
  const x = unwrap(e);
  return x.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(x) && Number(x.text) !== 0)
    || (ts.isStringLiteralLike(x) && x.text !== '') || ts.isObjectLiteralExpression(x) || ts.isArrayLiteralExpression(x);
};
/** An argument that can never be truthy keeps the connection, exactly as no argument does. */
const constantFalsy = (e: ts.Expression): boolean => {
  const x = unwrap(e);
  return x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(x)
    || (ts.isIdentifier(x) && (x.text === 'undefined' || x.text === 'NaN')) || (ts.isNumericLiteral(x) && Number(x.text) === 0)
    || (ts.isStringLiteralLike(x) && x.text === '')
    || (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken && constantTruthy(x.operand));
};
/** A rollbackFailed / rollbackError call ON THIS CLIENT: a function may hold two (withPlatformAdmin does). */
const callsRollback = (n: ts.Node, client: string) => find(n, (c) => ts.isCallExpression(c) && ts.isIdentifier(c.expression)
  && (c.expression.text === 'rollbackFailed' || c.expression.text === 'rollbackError')
  && c.arguments[0]?.getText() === client).length > 0;
const queries = (n: ts.Node, client: string) => find(n, (c) => ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression)
  && c.expression.name.text === 'query' && c.expression.expression.getText() === client).length > 0;
const isFunction = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
  || ts.isMethodDeclaration(n) || ts.isSourceFile(n);

/**
 * Names that, inside `fn`, hold the outcome of a ROLLBACK on `client`: assigned from
 * rollbackFailed/rollbackError called with that client, from each other, or caught around a query on it.
 */
function outcomeNames(fn: ts.Node, client: string): Set<string> {
  const names = new Set<string>();
  const sets: Array<{ name: string; from: ts.Node }> = [];
  for (const n of find(fn, () => true)) {
    if (ts.isVariableDeclaration(n) && n.initializer) sets.push({ name: n.name.getText(), from: n.initializer });
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) sets.push({ name: n.left.getText(), from: n.right });
    if (ts.isCatchClause(n) && n.variableDeclaration && queries(n.parent.tryBlock, client)) names.add(n.variableDeclaration.name.getText());
  }
  const mentions = (from: ts.Node) => find(from, (m) => (ts.isIdentifier(m) || ts.isPropertyAccessExpression(m)) && names.has(m.getText())).length > 0;
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sets) {
      if (!names.has(s.name) && (callsRollback(s.from, client) || mentions(s.from))) { names.add(s.name); grew = true; }
    }
  }
  return names;
}

function releases(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const root = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const ref of find(root, (n) => isReleaseRef(n))) {
    const call = ref.parent;
    if (!ts.isCallExpression(call) || call.expression !== ref || call.arguments.some(ts.isSpreadElement)) {
      out.push({ kind: 'indirect', text: ref.parent.getText(), node: ref });
      continue;
    }
    if (call.arguments.every(constantFalsy)) { out.push({ kind: 'bare', text: call.getText(), node: call }); continue; }
    let fn: ts.Node = call;
    while (!isFunction(fn)) fn = fn.parent;
    const client = (ref as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression.getText();
    const names = outcomeNames(fn, client);
    const arg = call.arguments[0]!;
    const proven = callsRollback(arg, client)
      || find(arg, (m) => (ts.isIdentifier(m) || ts.isPropertyAccessExpression(m)) && names.has(m.getText())).length > 0;
    if (!proven) out.push({ kind: 'unproven', text: call.getText(), node: call });
  }
  for (const b of find(root, (n) => ts.isBindingElement(n) && (n.propertyName ?? n.name).getText() === 'release')) {
    out.push({ kind: 'indirect', text: b.parent.getText(), node: b });
  }
  return out;
}
/** Rule 2: the release sits in a `finally` block that also ends a pool (`x.end()`), exactly once. */
function endsItsPoolInTheSameFinally(release: ts.Node): boolean {
  let block: ts.Node | undefined = release;
  const isFinally = (n: ts.Node) => n.parent !== undefined && ts.isTryStatement(n.parent) && n.parent.finallyBlock === n;
  while (block && !isFinally(block)) block = block.parent;
  if (!block) return false;
  return find(block, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
    && n.expression.name.text === 'end' && n.arguments.length === 0).length === 1;
}
const kinds = (snippet: string) => releases('s.ts', snippet).map((f) => f.kind);
const endsPool = (snippet: string) => releases('s.ts', snippet).map((f) => endsItsPoolInTheSameFinally(f.node));
const inFn = (body: string) => `async function f(c) { let u = false; ${body} }`;

const scanned: Record<string, Finding[]> = {};
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('release')) scanned[file] = releases(file, text);
}
const all = (kind: Kind) => Object.entries(scanned).flatMap(([file, fs]) => fs.filter((f) => f.kind === kind).map((f) => `${file}: ${f.text}`));

describe('R-176: no transaction owner releases its connection bare', () => {
  it('the tracked tree was read', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(Object.keys(scanned)).toEqual(expect.arrayContaining(['src/lib/auth/withAuth.ts', 'src/lib/neon.ts', 'scripts/_pg.ts',
      'pages/api/auth/verify-email.ts', 'src/lib/publicRouteTx.ts', 'src/lib/alsTransaction.ts', 'scripts/apply-migrations.ts']));
    expect(sources).toEqual(expect.arrayContaining(['middleware.ts', 'instrumentation.ts']));
  });

  it.each(['c.release();', "c['release']();", 'c.release(undefined);', 'c.release(false);', 'c.release(null);', 'c.release(0);',
    "c.release('');", 'c.release(``);', 'c.release(void 0);', 'c.release(!1);', 'c.release((false));', 'a.b.c.release();'])(
    'bare: %s', (snippet) => { expect(kinds(snippet)).toEqual(['bare']); });

  it.each(['c.release.call(c);', 'c.release.apply(c, []);', 'c.release.bind(c)();', 'c.release(...[]);', 'c.release(...args);',
    'const done = c.release; done();', 'const { release } = c; release();', 'const { release: done } = c; done();',
    'setImmediate(c.release);', 'later(c.release, 0);'])(
    'indirect, fails closed: %s', (snippet) => { expect(kinds(snippet)).toContain('indirect'); });

  it.each([
    inFn('try { await c.query("x"); } finally { c.release(u); }'), // never assigned from a ROLLBACK's outcome
    inFn('u = true; c.release(u);'),
    'function f(c, unusable) { c.release(unusable); }',
    'c.release(true);', 'c.release(err);', "c.release(new Error('x'));",
    // the outcome belongs to a ROLLBACK on another client, in the same function (withPlatformAdmin holds two)
    'async function f(a, b) { const gone = await rollbackFailed(a, "s"); a.release(gone); b.release(gone); }',
    'async function f(a, b) { let bad; try { await a.query("ROLLBACK"); } catch (e) { bad = e; } b.release(bad); }',
    // the outcome belongs to another function's ROLLBACK
    'async function a(d) { const u = await rollbackFailed(d, "s"); return u; } async function f(c) { let u = false; c.release(u); }',
    'async function a(c) { const u = await rollbackFailed(c, "s"); return u; } async function f(c) { let u = false; c.release(u); }',
  ])('unproven, fails closed: %s', (snippet) => { expect(kinds(snippet)).toEqual(['unproven']); });

  it.each([
    inFn('try { await c.query("x"); } catch (e) { u = await rollbackFailed(c, "s"); throw e; } finally { c.release(u); }'),
    inFn('const failed = await rollbackFailed(c, "s"); u = u || failed; c.release(u);'),
    inFn('const err = await rollbackError(c, "s"); u = err !== null; c.release(u);'),
    inFn('u = await rollbackFailed(c, "s"); c.release(u ? new Error("rollback failed") : undefined);'),
    inFn('c.release(await rollbackFailed(c, "s"));'),
    inFn('let bad; try { await c.query("ROLLBACK"); } catch (rollbackErr) { bad = rollbackErr; } c.release(bad);'),
    'release();', 'c.releaseAll();', 'const release = 1;', "log('release');",
  ])('proven or not a release: %s', (snippet) => { expect(kinds(snippet)).toEqual([]); });

  it('nothing reaches .release indirectly, and every argument is a ROLLBACK outcome', () => {
    expect(all('indirect'), 'call .release(...) directly, so its argument can be checked').toEqual([]);
    expect(all('unproven'), 'release with the result of rollbackFailed() from the same function').toEqual([]);
  });

  it('every bare release is one of the pinned ones', () => {
    const found = Object.fromEntries(Object.entries(scanned)
      .map(([file, fs]) => [file, fs.filter((f) => f.kind === 'bare').map((f) => f.text)] as const).filter(([, calls]) => calls.length > 0));
    expect(found, 'a bare .release(): release with the result of rollbackFailed(), or pin it in BARE with the '
      + 'reason no later caller can receive that connection')
      .toEqual(Object.fromEntries(Object.entries(BARE).map(([file, entry]) => [file, entry.calls])));
  });

  it.each([
    ['try { await work(); } finally { c.release(); await pool.end(); }', true],
    ['try { await work(); } finally { c.release(); }', false], // the pool lives on
    ['await work(); c.release(); await pool.end();', false], // not in a finally: a throw skips both
    ['try { try { await work(); } finally { c.release(); } } finally { await pool.end(); }', false], // another finally
    ['try { await work(); } finally { c.release(); await pool.query("x"); }', false],
  ] as const)('a per-run pool is ended in the same finally: %s -> %s', (snippet, expected) => {
    expect(endsPool(snippet)).toEqual([expected]);
  });

  it.each(Object.entries(BARE).filter(([, e]) => e.reason === PER_RUN_POOL || e.reason === RUNS_ON_IMPORT).map(([file]) => file))(
    '%s: the pinned release sits in a finally that also ends its pool', (file) => {
      const bare = scanned[file]!.filter((f) => f.kind === 'bare');
      expect(bare).toHaveLength(1);
      expect(endsItsPoolInTheSameFinally(bare[0]!.node), 'a pool that outlives this finally can hand the connection out again').toBe(true);
    });
});
