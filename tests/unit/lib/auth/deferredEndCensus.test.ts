/**
 * R-159 census — the wrapper contract for a deferred response flush.
 *
 * A wrapper that swaps res.end for a buffer must answer a throw itself: if it rethrows with the
 * buffer still in place, every later answer is swallowed and the client hangs. So:
 *   1. the only file that swaps res.end is src/lib/auth/deferredEnd.ts;
 *   2. the callers of deferEnd are exactly the three request-transaction wrappers;
 *   3. in each, the try that calls deferEnd has a catch that calls answerThrow and throws nothing.
 *
 * Reads the tracked tree (git ls-files), so a new wrapper that swaps res.end by hand fails (1),
 * and one that calls deferEnd without answering a throw fails (2) or (3).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const WRAPPERS = ['src/lib/auth/bearerPipeline.ts', 'src/lib/auth/withAuth.ts', 'src/lib/auth/withExtensionToken.ts'];

const sources = execFileSync('git', ['ls-files', 'src', 'pages'], { encoding: 'utf8' })
  .trim().split('\n').filter((f) => /\.tsx?$/.test(f));

const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

const find = (root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => { if (pred(n)) out.push(n); ts.forEachChild(n, visit); };
  visit(root);
  return out;
};

const callsNamed = (name: string) => (n: ts.Node) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name;

/**
 * Anything that replaces a property named `end`, whatever the receiver is called:
 * `x.end =`, `(x as any).end =`, `x['end'] =`, `Object.defineProperty(x, 'end', …)` and
 * `Object.assign(x, { end })`. A receiver-name filter would miss `apiRes.end =` or an alias.
 * This fails closed. A file that sets a non-response `end` (a date range, say) goes in
 * NOT_A_RESPONSE, with the reason.
 */
const NOT_A_RESPONSE: Record<string, string> = {};
const isObjectCall = (n: ts.CallExpression, method: string) => ts.isPropertyAccessExpression(n.expression)
  && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Object'
  && n.expression.name.text === method;
const hasEndProperty = (o: ts.Expression) => ts.isObjectLiteralExpression(o) && o.properties.some((p) =>
  p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === 'end');
const assignsEnd = (n: ts.Node) => {
  if (ts.isCallExpression(n)) {
    if (isObjectCall(n, 'defineProperty')) {
      const key = n.arguments[1];
      return key !== undefined && ts.isStringLiteralLike(key) && key.text === 'end';
    }
    if (isObjectCall(n, 'assign')) return n.arguments.slice(1).some(hasEndProperty);
    return false;
  }
  if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = n.left;
  if (ts.isPropertyAccessExpression(left)) return left.name.text === 'end';
  return ts.isElementAccessExpression(left)
    && ts.isStringLiteralLike(left.argumentExpression) && left.argumentExpression.text === 'end';
};
const flags = (snippet: string) => find(ts.createSourceFile('s.ts', snippet, ts.ScriptTarget.Latest, true), assignsEnd).length > 0;

describe('R-159: a deferred res.end is always answered on a throw', () => {
  it('the tracked tree was read', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toEqual(expect.arrayContaining([...WRAPPERS, 'src/lib/auth/deferredEnd.ts']));
  });

  it.each([
    'apiRes.end = f;', 'r.end = f;', '(httpRes as any).end = f;', "nextRes['end'] = f;",
    'const target = res; target.end = f;', "Object.defineProperty(res, 'end', { value: f });",
    'Object.assign(res, { end: f });', "Object.assign(out, { 'end': f });",
  ])('the matcher flags %s', (snippet) => {
    expect(flags(snippet)).toBe(true);
  });

  it.each(['const end = 1;', 'res.end(body);', 'range.start = 1;', 'Object.assign(res, { status: 1 });'])(
    'the matcher leaves %s alone', (snippet) => {
      expect(flags(snippet)).toBe(false);
    });

  it('only deferredEnd.ts swaps res.end', () => {
    const swapping = sources.filter((f) => !(f in NOT_A_RESPONSE)
      && /\bend\b/.test(readFileSync(f, 'utf8')) && find(parse(f), assignsEnd).length > 0);
    expect(swapping, 'files assigning `.end =`: a response must go through deferEnd; anything else '
      + 'goes in NOT_A_RESPONSE with a reason').toEqual(['src/lib/auth/deferredEnd.ts']);
  });

  it('the callers of deferEnd are exactly the three request-transaction wrappers', () => {
    const callers = sources.filter((f) => f !== 'src/lib/auth/deferredEnd.ts'
      && readFileSync(f, 'utf8').includes('deferEnd') && find(parse(f), callsNamed('deferEnd')).length > 0);
    expect(callers.sort()).toEqual(WRAPPERS);
  });

  it.each(WRAPPERS)('%s: the try around deferEnd catches with answerThrow and never rethrows', (file) => {
    const deferCalls = find(parse(file), callsNamed('deferEnd'));
    expect(deferCalls).toHaveLength(1);
    let node: ts.Node | undefined = deferCalls[0];
    while (node && !(ts.isTryStatement(node.parent) && node.parent.tryBlock === node)) node = node.parent;
    const tryStmt = node?.parent as ts.TryStatement | undefined;
    const handler = tryStmt?.catchClause?.block;
    expect(handler, 'deferEnd must be called inside a try block with a catch').toBeDefined();
    expect(find(handler!, callsNamed('answerThrow'))).toHaveLength(1);
    expect(find(handler!, ts.isThrowStatement)).toHaveLength(0);
  });
});
