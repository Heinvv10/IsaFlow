/**
 * PR #1405 review round 7 (M1), by census over pages/api/admin/** (git ls-files): every logAdminAction whose target
 * type is 'user' names the STORED user id, taken from adminStoredUser / findStoredUser / resetPasswordRefusal (or a
 * row they returned), never the request's own spelling (req.query, adminUserId). users.id is TEXT and two rows can
 * differ only in case, so the audit log itself does not re-map a user id: the route must pass the stored one.
 *
 * The 4th argument must be exactly the stored id, by shape (see isStored).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

/** `await <resolver>(…)`: a stored-user row (the whole initialiser, nothing else mixed in). */
const ROW = /^await (adminStoredUser|findStoredUser|resetPasswordRefusal)\([^;]*\)$/;
/** `(await adminStoredUser(…)).id` / `(await findStoredUser(…)).id`: the stored id in one expression. */
const INLINE_ID = /^\(await (adminStoredUser|findStoredUser)\([^;]*\)\)\.id$/;
/**
 * The ONE named exception: remove-from-company's orphan path audits a membership whose user has no users row, under
 * the id it was stored under (nothing else to name it by). Only this file, only this identifier, only once.
 */
const ORPHAN_PATH = { file: 'pages/api/admin/users/[id]/remove-from-company.ts', target: 'orphanUserId', calls: 1 };

const files = execFileSync('git', ['ls-files', 'pages/api/admin'], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.ts'));

function declarations(source: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) out.set(n.name.text, n.initializer.getText());
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

/**
 * Whether `expr` (an audit target argument) is the stored id: exactly `(await adminStoredUser(…)).id`, or `x.id` /
 * `x.userId` where `const x = await <resolver>(…)`, or an identifier initialised to one of those. Nothing else: an
 * initialiser that also mentions the request (`… && req.query.id`) is not the stored id.
 */
function isStored(expr: string, decls: Map<string, string>, depth = 0): boolean {
  if (depth > 3) return false;
  if (INLINE_ID.test(expr)) return true; // anchored: nothing may follow the resolver's .id
  const prop = /^(\w+)\.(id|userId)$/.exec(expr);
  if (prop) return ROW.test(decls.get(prop[1]!) ?? '');
  if (/^\w+$/.test(expr)) {
    const init = decls.get(expr);
    return init !== undefined && isStored(init, decls, depth + 1);
  }
  return false;
}

/** Every logAdminAction(…, 'user', <target>, …) in `file` whose target is NOT the stored id: "line: target". */
function unresolvedUserTargets(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const decls = declarations(source);
  const found: string[] = [];
  let orphanCalls = 0;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText() === 'logAdminAction') {
      const [, , type, target] = n.arguments;
      const orphan = file === ORPHAN_PATH.file && target?.getText() === ORPHAN_PATH.target;
      if (orphan) orphanCalls += 1;
      if (type && ts.isStringLiteral(type) && type.text === 'user' && target && !orphan && !isStored(target.getText(), decls)) {
        found.push(`${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${target.getText()}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  if (file === ORPHAN_PATH.file && orphanCalls !== ORPHAN_PATH.calls) found.push(`orphan path audits ${orphanCalls}x, pinned ${ORPHAN_PATH.calls}`);
  return found;
}

describe("admin audit rows about a user name the stored id (review #1405 round 7)", () => {
  it('finds the user-target audits', () => {
    const withUserAudits = files.filter((f) => /logAdminAction\([^)]*'user'/s.test(readFileSync(f, 'utf8')));
    expect(withUserAudits.length).toBeGreaterThanOrEqual(10);
  });

  it("every logAdminAction(…, 'user', target) takes target from adminStoredUser / findStoredUser / resetPasswordRefusal", () => {
    const bad = Object.fromEntries(files.map((f) => [f, unresolvedUserTargets(f)]).filter(([, v]) => v.length > 0));
    expect(bad).toEqual({});
  });
});
