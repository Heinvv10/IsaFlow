/**
 * #1656 round 9 (LOW): approval_request_decide (migration 872) still admits a withheld manager, because its SQL knows no per-module
 * Approve (a deliberate non-change: the SQL is left as it is). So the TypeScript gate is the ONLY stop, and this census pins it:
 * decideRequest, the one function that calls the definer, is called from exactly one place, the approval-requests route, and there
 * only after `refuseApprovalRequestWithoutApprove` on the path that approves (`if (decision === 'approved' && ... await refuse...) return;`).
 * A second caller, or the gate moved after the call or made conditional on something else, fails here.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const ROUTE = 'pages/api/accounting/approval-requests.ts';

describe('decideRequest and approval_request_decide', () => {
  it('decideRequest is called from the approval-requests route and nowhere else; approval_request_decide only from approvalRequestWrites', () => {
    const files = execFileSync('git', ['ls-files', 'src', 'pages'], { encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f));
    const callers: string[] = [];
    const definer: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'decideRequest') callers.push(f);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (/FROM\s+approval_request_decide\s*\(/i.test(text)) definer.push(f);
    }
    expect([...new Set(callers)]).toEqual([ROUTE]);
    expect(definer).toEqual(['src/modules/accounting/services/gl/approvalRequestWrites.ts']);
  });

  it('in the route, the approving path is refused (an if whose then-branch returns) BEFORE decideRequest, in the same function', () => {
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
    // the same block: the gate is a statement that precedes the call's statement in an enclosing block, so it dominates it
    let blockWithBoth = false;
    for (let p: ts.Node | undefined = decide!.parent; p; p = p.parent) {
      if (ts.isBlock(p) && p.statements.includes(gateIf!)) blockWithBoth = true;
    }
    expect(blockWithBoth, 'the gate sits in a block that also encloses decideRequest').toBe(true);
  });
});
