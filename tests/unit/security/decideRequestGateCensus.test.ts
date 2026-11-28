/**
 * #1656 rounds 9 and 10 (LOW): approval_request_decide (migration 872) still admits a withheld manager, because its SQL knows no per-module
 * Approve (a deliberate non-change: the SQL is left as it is). So the TypeScript gate is the ONLY stop, and this census pins it:
 * decideRequest, which calls decideRequestRow, which calls the definer, is called from exactly one place, the approval-requests route, and
 * there only after the approve gate (an `if (decision === 'approved' && ... refuseApprovalRequestWithoutApprove(...)) return;`).
 *
 * Callers are found through the TYPE CHECKER's symbol resolution (aliases and barrel re-exports followed, property calls `x.decideRequest()`
 * included), never by the name at the call site: `import { decideRequest as d }` is the same function. The analyser is mutation-proved below
 * on a virtual project with an aliased second caller.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { programFor } from '../helpers/approveCensusProgram';

const ROUTE = 'pages/api/accounting/approval-requests.ts';
const SERVICE = 'src/modules/accounting/services/gl/approvalService.ts';
const WRITES = 'src/modules/accounting/services/gl/approvalRequestWrites.ts';
/**
 * Wave 6 OC (#1679): cancelling an off-cycle run withdraws its pending request, a REJECTION only, behind owner/admin and Payroll
 * Approve (pages/api/payroll/runs/[id]/cancel.ts). It is the one other caller, and every call it makes passes the literal 'rejected'
 * (asserted below), so the route stays the only path that approves.
 */
const CANCEL = 'src/modules/accounting/services/payroll/payrollRunCancel.ts';

/** The function `name` declared in `declFile` that `id` resolves to (aliases and barrel re-exports followed), else undefined. */
function resolvesTo(checker: ts.TypeChecker, id: ts.Node, name: string, declFile: string, rel: (f: string) => string): boolean {
  let sym = checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const d = sym?.declarations?.[0];
  return Boolean(d && rel(d.getSourceFile().fileName) === declFile && sym!.name === name);
}

/** A callee without the parentheses, `as` casts and non-null assertions around it. */
const unwrapCallee = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  return x;
};

/** `e` names a namespace import (`import * as m`) of `declFile`'s module. */
function isNamespaceOf(checker: ts.TypeChecker, e: ts.Node, declFile: string, rel: (f: string) => string): boolean {
  if (!ts.isIdentifier(e)) return false;
  let sym = checker.getSymbolAtLocation(e);
  if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return false;
  if (!sym.declarations?.some((d) => ts.isNamespaceImport(d))) return false;
  sym = checker.getAliasedSymbol(sym);
  const d = sym.declarations?.[0];
  return Boolean(d && ts.isSourceFile(d) && rel(d.fileName) === declFile);
}

/** Every call (with its file's relative path) that RESOLVES to a function declared `name` in `declFile`. */
function callsOf(program: ts.Program, name: string, declFile: string, rel: (f: string) => string): { file: string; call: ts.CallExpression }[] {
  const checker = program.getTypeChecker();
  const out: { file: string; call: ts.CallExpression }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = unwrapCallee(n.expression);
        // `ns.decideRequest(...)`, `ns['decideRequest'](...)` (review L-a of 87708dc593) or `decideRequest(...)`.
        const id = ts.isPropertyAccessExpression(callee) ? callee.name
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression : callee;
        const hit = resolvesTo(checker, id, name, declFile, rel)
          || (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === name
            && isNamespaceOf(checker, unwrapCallee(callee.expression), declFile, rel));
        if (hit) out.push({ file: rel(sf.fileName), call: n });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Every file (relative path) holding a call that RESOLVES to a function declared `name` in `declFile`. */
function callersOf(program: ts.Program, name: string, declFile: string, rel: (f: string) => string): string[] {
  return [...new Set(callsOf(program, name, declFile, rel).map((c) => c.file))].sort();
}

/**
 * In `file`, what each resolved decideRequest call passes as its decision (a string literal's text, else a marker), plus every
 * reference to decideRequest that is not a call's callee or an import (a value passed on, which could be called with anything).
 * Review L1 of 819c2861c0: by symbol, so a namespace (`approvals.decideRequest`) or aliased (`as settle`) call is seen too.
 */
function decisionsIn(program: ts.Program, file: string, declFile: string, rel: (f: string) => string): string[] {
  const out = callsOf(program, 'decideRequest', declFile, rel).filter((c) => c.file === file).map(({ call }) => {
    const arg = call.arguments[2];
    return arg && ts.isStringLiteral(arg) ? arg.text : `<not a literal: ${arg?.getText() ?? 'missing'}>`;
  });
  const sf = program.getSourceFiles().find((f) => rel(f.fileName) === file);
  const checker = program.getTypeChecker();
  const visit = (n: ts.Node) => {
    // A namespace import of approvalService is used only as `m.name` or `m['literal']` (review L-a of 87708dc593): anything
    // else (a computed key, a cast, passing the namespace on) could reach decideRequest unseen.
    if (ts.isIdentifier(n) && !ts.isNamespaceImport(n.parent) && isNamespaceOf(checker, n, declFile, rel)) {
      const named = (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)
        || (ts.isElementAccessExpression(n.parent) && n.parent.expression === n && ts.isStringLiteralLike(n.parent.argumentExpression));
      // `m['decideRequest']` (or a template key) is decideRequest itself: like a bare reference, it must be a call's callee
      // (review r11 of 0281f8081e: `const f = m['decideRequest']` and `m['decideRequest'].call(...)` reach it unseen).
      const el = n.parent;
      if (named && ts.isElementAccessExpression(el) && ts.isStringLiteralLike(el.argumentExpression) && el.argumentExpression.text === 'decideRequest') {
        let callee: ts.Node = el;
        while (ts.isParenthesizedExpression(callee.parent) || ts.isAsExpression(callee.parent) || ts.isNonNullExpression(callee.parent)) callee = callee.parent;
        if (!(ts.isCallExpression(callee.parent) && callee.parent.expression === callee)) out.push(`<a reference, not a call: ${el.getText()}>`);
      }
      if (!named) {
        let outer: ts.Node = n;
        while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isNonNullExpression(outer.parent)) outer = outer.parent;
        const shown = ts.isElementAccessExpression(outer.parent) ? outer.parent : outer;
        out.push(`<a namespace import used other than by a property name: ${shown.getText()}>`);
      }
    }
    if (ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent) && !ts.isNamespaceImport(n.parent) && resolvesTo(checker, n, 'decideRequest', declFile, rel)) {
      const callee = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
      if (!(ts.isCallExpression(callee.parent) && callee.parent.expression === callee)) out.push(`<a reference, not a call: ${n.parent.getText()}>`);
    }
    ts.forEachChild(n, visit);
  };
  if (sf) visit(sf);
  return out;
}

describe('decideRequest and approval_request_decide', () => {
  const files = execFileSync('git', ['ls-files', 'src', 'pages'], { encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
  const real = () => programFor(files.map((f) => resolve(process.cwd(), f)));
  const relReal = (f: string) => f.replace(`${process.cwd()}/`, '');

  it('decideRequest has one approving caller (the approval-requests route) and one rejecting (off-cycle cancel); decideRequestRow one (approvalService); the definer is read only by approvalRequestWrites', () => {
    const p = real();
    expect(callersOf(p, 'decideRequest', SERVICE, relReal)).toEqual([ROUTE, CANCEL].sort());
    expect(callersOf(p, 'decideRequestRow', WRITES, relReal)).toEqual([SERVICE]);
    const definer = files.filter((f) => /FROM\s+approval_request_decide\s*\(/i.test(readFileSync(f, 'utf8')));
    expect(definer).toEqual([WRITES]);
  }, 180_000);

  it('off-cycle cancel only ever rejects: every call resolving to decideRequest there passes the string literal \'rejected\'', () => {
    expect(decisionsIn(real(), CANCEL, SERVICE, relReal)).toEqual(['rejected']);
  }, 180_000);

  it('in the route, the approving path is refused (an if whose then-branch returns) BEFORE decideRequest, in an enclosing block', () => {
    const sf = ts.createSourceFile(ROUTE, readFileSync(ROUTE, 'utf8'), ts.ScriptTarget.Latest, true);
    let decide: ts.CallExpression | undefined;
    let gateIf: ts.IfStatement | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'decideRequest') decide = n;
      if (ts.isIfStatement(n) && /decision === 'approved'/.test(n.expression.getText()) && /refuseApprovalRequestWithoutApprove\(/.test(n.expression.getText())
        && /^return\b|^\{\s*return\b/.test(n.thenStatement.getText())) gateIf = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(decide, 'decideRequest call').toBeDefined();
    expect(gateIf, 'the approve gate').toBeDefined();
    expect(gateIf!.getEnd()).toBeLessThan(decide!.getStart());
    // round 10: the gate does not depend on the row being found (`&& requestRow &&` made it skip when the unlocked read came back empty)
    expect(gateIf!.expression.getText()).not.toMatch(/requestRow\s*&&/);
    let enclosed = false;
    for (let p: ts.Node | undefined = decide!.parent; p; p = p.parent) if (ts.isBlock(p) && p.statements.includes(gateIf!)) enclosed = true;
    expect(enclosed, 'the gate sits in a block that also encloses decideRequest').toBe(true);
  });

  describe('the analyser itself (mutation proof on a virtual project)', () => {
    const project = (extra: Record<string, string>) => {
      const v: Record<string, string> = {
        '/v/svc.ts': 'export async function decideRequest(c: string) { return c; }\nexport const noop = 1;',
        '/v/barrel.ts': "export { decideRequest as decideViaBarrel } from './svc';",
        '/v/route.ts': "import { decideRequest } from './svc';\nexport async function r() { await decideRequest('c'); }",
        ...extra,
      };
      const p = programFor(Object.keys(v), v);
      return callersOf(p, 'decideRequest', '/v/svc.ts', (f) => f);
    };
    it('baseline: only the route', () => expect(project({})).toEqual(['/v/route.ts']));
    it('an ALIASED import is caught', () => {
      expect(project({ '/v/second.ts': "import { decideRequest as d } from './svc';\nexport async function x() { await d('c'); }" })).toEqual(['/v/route.ts', '/v/second.ts']);
    });
    it('a re-export through a barrel under another name is caught', () => {
      expect(project({ '/v/third.ts': "import { decideViaBarrel } from './barrel';\nexport async function x() { await decideViaBarrel('c'); }" })).toEqual(['/v/route.ts', '/v/third.ts']);
    });
    it('a property call on a namespace import is caught', () => {
      expect(project({ '/v/fourth.ts': "import * as svc from './svc';\nexport async function x() { await svc.decideRequest('c'); }" })).toEqual(['/v/fourth.ts', '/v/route.ts']);
    });
    // Review L1 of 819c2861c0: the cancel pin, by symbol.
    const decisions = (cancel: string) => {
      const v: Record<string, string> = {
        '/v/svc.ts': "export async function decideRequest(c: string, r: string, d: 'approved' | 'rejected') { return c + r + d; }",
        '/v/cancel.ts': cancel,
      };
      return decisionsIn(programFor(Object.keys(v), v), '/v/cancel.ts', '/v/svc.ts', (f) => f);
    };
    it('cancel pin baseline: a direct rejecting call', () => {
      expect(decisions("import { decideRequest } from './svc';\nexport const x = () => decideRequest('c', 'r', 'rejected');")).toEqual(['rejected']);
    });
    it('cancel pin: an approving call through a namespace import is caught', () => {
      expect(decisions("import * as approvals from './svc';\nexport const x = () => approvals.decideRequest('c', 'r', 'approved');")).toEqual(['approved']);
    });
    it('cancel pin: an approving call through an aliased import is caught', () => {
      expect(decisions("import { decideRequest as settle } from './svc';\nexport const x = () => settle('c', 'r', 'approved');")).toEqual(['approved']);
    });
    it('cancel pin: an approving call through a string-literal element access on a namespace is caught (review L-a of 87708dc593)', () => {
      expect(decisions("import * as m from './svc';\nexport const x = () => m['decideRequest']('c', 'r', 'approved');")).toEqual(['approved']);
    });
    it('cancel pin: a computed element access on a namespace that holds decideRequest is flagged', () => {
      expect(decisions("import * as m from './svc';\nconst k = 'decide' + 'Request';\nexport const x = () => (m as Record<string, Function>)[k]('c', 'r', 'approved');"))
        .toEqual(['<a namespace import used other than by a property name: (m as Record<string, Function>)[k]>']);
    });
    it('the analyser: a string-literal element access on a namespace is a caller', () => {
      expect(project({ '/v/fifth.ts': "import * as svc from './svc';\nexport async function x() { await svc['decideRequest']('c'); }" })).toEqual(['/v/fifth.ts', '/v/route.ts']);
    });
    // Review r11 of 0281f8081e: the element-access form used as a value, not called.
    it('cancel pin: m[\'decideRequest\'] passed on as a value is caught', () => {
      expect(decisions("import * as m from './svc';\nconst f = m['decideRequest'];\nexport const x = () => f('c', 'r', 'approved');"))
        .toEqual(["<a reference, not a call: m['decideRequest']>"]);
    });
    it('cancel pin: m[\'decideRequest\'].call(...) is caught', () => {
      expect(decisions("import * as m from './svc';\nexport const x = () => m['decideRequest'].call(null, 'c', 'r', 'approved');"))
        .toEqual(["<a reference, not a call: m['decideRequest']>"]);
    });
    it('cancel pin: a template key used as a value is caught', () => {
      expect(decisions("import * as m from './svc';\nconst f = m[`decideRequest`];\nexport const x = () => f('c', 'r', 'approved');"))
        .toEqual(['<a reference, not a call: m[`decideRequest`]>']);
    });
    it('cancel pin: decideRequest passed on as a value is caught', () => {
      expect(decisions("import { decideRequest } from './svc';\nconst f = decideRequest;\nexport const x = () => f('c', 'r', 'approved');"))
        .toEqual(['<a reference, not a call: f = decideRequest>']);
    });
    it('a same-named function elsewhere is NOT a caller', () => {
      expect(project({ '/v/other.ts': "function decideRequest(c: string) { return c; }\nexport const y = decideRequest('c');" })).toEqual(['/v/route.ts']);
    });
  });
});
