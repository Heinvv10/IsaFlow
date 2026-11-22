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
const CANCEL = 'src/modules/accounting/services/payroll/payrollOffCycleCancel.ts';

/** Every file (relative path) holding a call that RESOLVES to a function declared `name` in `declFile`. */
function callersOf(program: ts.Program, name: string, declFile: string, rel: (f: string) => string): string[] {
  const checker = program.getTypeChecker();
  const out = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const id = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
        let sym = checker.getSymbolAtLocation(id);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const d = sym?.declarations?.[0];
        if (d && rel(d.getSourceFile().fileName) === declFile && sym!.name === name) out.add(rel(sf.fileName));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...out].sort();
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

  it('off-cycle cancel only ever rejects: every decideRequest call there passes the string literal \'rejected\' as its decision', () => {
    const sf = ts.createSourceFile(CANCEL, readFileSync(CANCEL, 'utf8'), ts.ScriptTarget.Latest, true);
    const decisions: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'decideRequest') {
        const arg = n.arguments[2];
        decisions.push(arg && ts.isStringLiteral(arg) ? arg.text : `<not a literal: ${arg?.getText(sf) ?? 'missing'}>`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(decisions).toEqual(['rejected']);
  });

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
    it('a same-named function elsewhere is NOT a caller', () => {
      expect(project({ '/v/other.ts': "function decideRequest(c: string) { return c; }\nexport const y = decideRequest('c');" })).toEqual(['/v/route.ts']);
    });
  });
});
