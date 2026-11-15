/**
 * PR #1405 review round 7 (M1), by census over pages/api/admin/** (git ls-files): every logAdminAction whose target
 * type is 'user' names the STORED user id, taken from adminStoredUser / findStoredUser / resetPasswordRefusal (or a
 * row they returned), never the request's own spelling (req.query, adminUserId). users.id is TEXT and two rows can
 * differ only in case, so the audit log itself does not re-map a user id: the route must pass the stored one.
 *
 * The 4th argument must be an identifier (or `x.id` / `x.userId`) whose declaration in the same file is initialised
 * from one of those resolvers, directly (`(await adminStoredUser(...)).id`) or through one hop (`const t = await
 * findStoredUser(...)`, `const userId = t.id`).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const RESOLVER = /\b(adminStoredUser|findStoredUser|resetPasswordRefusal)\(/;
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

/** Whether `expr` (an audit target argument) is the stored id, per the rule above. */
function isStored(expr: string, decls: Map<string, string>, depth = 0): boolean {
  if (depth > 3 || /req\.query|adminUserId\(/.test(expr) && !RESOLVER.test(expr)) return false;
  if (RESOLVER.test(expr)) return true;
  const prop = /^(\w+)\.(id|userId)$/.exec(expr);
  const name = prop ? prop[1]! : /^\w+$/.test(expr) ? expr : null;
  const init = name ? decls.get(name) : undefined;
  return init !== undefined && isStored(init, decls, depth + 1);
}

/** Every logAdminAction(…, 'user', <target>, …) in `file` whose target is NOT the stored id: "line: target". */
function unresolvedUserTargets(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const decls = declarations(source);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText() === 'logAdminAction') {
      const [, , type, target] = n.arguments;
      if (type && ts.isStringLiteral(type) && type.text === 'user' && target && !isStored(target.getText(), decls)) {
        found.push(`${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${target.getText()}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
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
