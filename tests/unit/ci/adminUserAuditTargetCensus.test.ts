/**
 * PR #1405 review rounds 7-8 (M1, R2-R4), by census over pages/api/admin/** (git ls-files): every logAdminAction whose
 * target type is 'user' names the STORED user id, taken from adminStoredUser / findStoredUser / resetPasswordRefusal,
 * never the request's own spelling (req.query, adminUserId). users.id is TEXT and two rows can differ only in case, so
 * the audit log itself does not re-map a user id: the route must pass the stored one.
 *
 * The target is accepted only in these shapes (anything else is flagged):
 *   - `(await adminStoredUser(<arg>)).id` / `(await findStoredUser(<arg>)).id`;
 *   - `x.id` / `x.userId` where `const x = await <resolver>(<arg>)`;
 *   - an identifier declared `const` (never reassigned) and initialised to one of those.
 * <arg> is one simple argument: a name or property chain (`req.query.id`, `requestedId`), or `adminUserId(<that>)`.
 * No `??`, `||` or `&&` anywhere in an initialiser (a fallback to the request's spelling, review round 8 R2). An
 * audit whose type argument is not a string literal is flagged too: it might be 'user' (R3). A name declared more
 * than once in a file (in another function, block or as a parameter) counts as not stored: the census reads names per
 * file, not per scope, so a same-named const elsewhere could otherwise vouch for it (final round).
 *
 * Known limit, accepted: only calls spelled `logAdminAction(` are seen. An alias (`const audit = logAdminAction`) or a
 * wrapper that forwards a 'user' target escapes this census.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const ARG = String.raw`(?:[\w.]+|adminUserId\([\w.]+\))`;
/** `await <resolver>(<arg>)`: a stored-user row, nothing else in the initialiser. */
const ROW = new RegExp(String.raw`^await (adminStoredUser|findStoredUser|resetPasswordRefusal)\(${ARG}\)$`);
/** `(await adminStoredUser(<arg>)).id` / `(await findStoredUser(<arg>)).id`: the stored id in one expression. */
const INLINE_ID = new RegExp(String.raw`^\(await (adminStoredUser|findStoredUser)\(${ARG}\)\)\.id$`);
const LOGICAL = /\?\?|\|\||&&/;
/**
 * The ONE named exception: remove-from-company's orphan path audits a membership whose user has no users row, under
 * the id it was stored under (nothing else to name it by). Only this file, only this identifier, only once.
 */
const ORPHAN_PATH = { file: 'pages/api/admin/users/[id]/remove-from-company.ts', target: 'orphanUserId', calls: 1 };

const files = execFileSync('git', ['ls-files', 'pages/api/admin'], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.ts'));

/** `const` declarations (initialiser text) of identifiers declared once in the file and never reassigned. */
function constDeclarations(source: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const notConst = new Set<string>();
  const declared = new Set<string>();
  const declare = (name: string) => { if (declared.has(name)) notConst.add(name); declared.add(name); };
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      declare(n.name.text);
      const isConst = (ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const) !== 0;
      if (!isConst || !n.initializer) notConst.add(n.name.text);
      else out.set(n.name.text, n.initializer.getText());
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) declare(n.name.text);
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) { declare(n.name.text); notConst.add(n.name.text); }
    // Any assignment to a name (x = …, x ??= …, ({ x } = …) via its identifier) disqualifies it.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const visitLeft = (l: ts.Node) => { if (ts.isIdentifier(l)) notConst.add(l.text); ts.forEachChild(l, visitLeft); };
      visitLeft(n.left);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  for (const name of notConst) out.delete(name);
  return out;
}

/** Whether `expr` (an audit target argument) is the stored id, by the shapes in the header. */
function isStored(expr: string, decls: Map<string, string>, depth = 0): boolean {
  if (depth > 3 || LOGICAL.test(expr)) return false;
  if (INLINE_ID.test(expr)) return true;
  const prop = /^(\w+)\.(id|userId)$/.exec(expr);
  if (prop) return ROW.test(decls.get(prop[1]!) ?? '');
  if (/^\w+$/.test(expr)) {
    const init = decls.get(expr);
    return init !== undefined && isStored(init, decls, depth + 1);
  }
  return false;
}

/** Every user-target audit in `file` whose target is NOT the stored id, and every non-literal type: "line: what". */
function unresolvedUserTargets(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const decls = constDeclarations(source);
  const found: string[] = [];
  let orphanCalls = 0;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText() === 'logAdminAction') {
      const line = source.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const [, , type, target] = n.arguments;
      if (type && !ts.isStringLiteral(type)) found.push(`${line}: type is not a string literal: ${type.getText()}`);
      const orphan = file === ORPHAN_PATH.file && target?.getText() === ORPHAN_PATH.target;
      if (orphan) orphanCalls += 1;
      if (type && ts.isStringLiteral(type) && type.text === 'user' && target && !orphan && !isStored(target.getText(), decls)) {
        found.push(`${line}: ${target.getText()}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  if (file === ORPHAN_PATH.file && orphanCalls !== ORPHAN_PATH.calls) found.push(`orphan path audits ${orphanCalls}x, pinned ${ORPHAN_PATH.calls}`);
  return found;
}

describe('admin audit rows about a user name the stored id (review #1405 rounds 7-8)', () => {
  it('finds the user-target audits', () => {
    const withUserAudits = files.filter((f) => /logAdminAction\([^)]*'user'/s.test(readFileSync(f, 'utf8')));
    expect(withUserAudits.length).toBeGreaterThanOrEqual(10);
  });

  it("every logAdminAction(…, 'user', target) takes target from adminStoredUser / findStoredUser / resetPasswordRefusal", () => {
    const bad = Object.fromEntries(files.map((f) => [f, unresolvedUserTargets(f)]).filter(([, v]) => v.length > 0));
    expect(bad).toEqual({});
  });
});
