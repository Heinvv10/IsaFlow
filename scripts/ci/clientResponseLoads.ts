/**
 * Classes e, f, g of the client-response gate: how a LOAD behaves when it fails.
 *   e  a busy flag set true in an async function with no `finally` that sets it false
 *   f  a load whose catch shows an error but does not clear what the try filled
 *   g  `if (!res.ok) return;` / `if (res.ok) {...}` as the last statement: a failure dropped
 * Syntactic on purpose (no type information needed); limits are in clientResponseRule.ts.
 */
import ts from 'typescript';
import { type Add, calls, enclosingFn, isFetchCall, isFn } from './clientResponseShared';

export function analyzeLoads(sf: ts.SourceFile, add: Add): void {
  // ── (e) a busy flag set true with no `finally` that clears it ─────────────
  const FLAG = /^set(\w*)(Loading|Saving|Busy|Submitting|Working|Running|Processing|Sending)\w*$/;
  const setterCalls = (root: ts.Node, name?: string): ts.CallExpression[] =>
    calls(root, (c) => ts.isIdentifier(c.expression) && (name ? c.expression.text === name : FLAG.test(c.expression.text)));
  const fnHasAwait = (fnNode: ts.Node) => { let a = false; const v = (n: ts.Node) => { if (ts.isAwaitExpression(n)) a = true; if (!a && !(isFn(n) && n !== fnNode)) ts.forEachChild(n, v); }; v(fnNode); return a; };
  const visitE = (n: ts.Node) => {
    if (isFn(n) && n.body && fnHasAwait(n)) {
      const own = (c: ts.Node) => enclosingFn(c) === n;
      const trues = setterCalls(n.body).filter((c) => own(c) && c.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword);
      for (const t of trues) {
        const name = (t.expression as ts.Identifier).text;
        let cleared = false;
        const visitF = (m: ts.Node) => {
          if (ts.isTryStatement(m) && m.finallyBlock && setterCalls(m.finallyBlock, name).some((c) => c.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword)) cleared = true;
          ts.forEachChild(m, visitF);
        };
        visitF(n.body);
        if (!cleared) add(t, 'e', `\`${name}(true)\` in an async function with no \`finally\` that calls ${name}(false): a thrown error leaves it set for good`);
      }
    }
    ts.forEachChild(n, visitE);
  };
  visitE(sf);

  // ── (f) a failed load (no write, or a `method` held in a variable counts as a write) that sets an error but keeps the rows it failed to refresh ──
  const IGNORE = /^set(\w*)(Loading|Saving|Busy|Error|Msg|Message|Toast|Success|Flash|Notice|Banner|Status|Open|Show|Selected|Page|Total|Confirm)\w*$/i;
  const visitG = (n: ts.Node) => {
    if (ts.isTryStatement(n) && n.catchClause) {
      const body = n.tryBlock; const handler = n.catchClause.block;
      const errSetter = setterCalls(handler).length >= 0 && calls(handler, (c) => ts.isIdentifier(c.expression) && /^set\w*(Error|Msg|Message|Toast|Flash|Notice)\w*$/i.test(c.expression.text)).length + calls(handler, (c) => /(notify|toast|showToast|alert)/.test(c.expression.getText(sf))).length > 0;
      if (errSetter) {
        // response bodies bound in the try block
        const bodies = new Set<string>();
        const bv = (m: ts.Node) => { if (ts.isVariableDeclaration(m) && m.initializer && ts.isIdentifier(m.name) && /\.(json|text)\(\)/.test(m.initializer.getText(sf))) bodies.add(m.name.text); ts.forEachChild(m, bv); };
        bv(body);
        const isWrite = calls(body, (c) => isFetchCall(c) && !!c.arguments[1] && /method\s*:\s*(?!['"`](GET|HEAD)['"`])/i.test(c.arguments[1].getText(sf))).length > 0;
        const readsApi = calls(body, (c) => isFetchCall(c) || (ts.isIdentifier(c.expression) && (c.expression.text === 'assertOk' || c.expression.text === 'apiJson'))).length > 0;
        if (bodies.size && !isWrite && readsApi) {
          const called = new Set(calls(handler, (c) => ts.isIdentifier(c.expression)).map((c) => (c.expression as ts.Identifier).text));
          for (const c of calls(body, (x) => ts.isIdentifier(x.expression) && /^set[A-Z]/.test(x.expression.text) && !IGNORE.test(x.expression.text))) {
            const name = (c.expression as ts.Identifier).text;
            const fromBody = !c.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && [...bodies].some((b) => new RegExp(`\\b${b}\\b`).test(c.arguments.map((a) => a.getText(sf)).join(',')));
            if (fromBody && !called.has(name)) add(c, 'f', `\`${name}\` is filled from the response but the catch (which shows an error) does not clear it: stale data stays under the new error`);
          }
        }
      }
    }
    ts.forEachChild(n, visitG);
  };
  visitG(sf);

  // ── (g) a failed response swallowed: `if (!res.ok) return;` and nothing said ─
  const visitS = (n: ts.Node) => {
    if (ts.isIfStatement(n) && !n.elseStatement) {
      const c = n.expression;
      const neg = ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken && ts.isPropertyAccessExpression(c.operand) && c.operand.name.text === 'ok';
      const pos = ts.isPropertyAccessExpression(c) && c.name.text === 'ok' && ts.isIdentifier(c.expression);
      const last = ts.isBlock(n.parent) ? n.parent.statements[n.parent.statements.length - 1] === n : true;   // anything after it may handle the failure
      if (pos && last) add(n, 'g', 'only the success branch is handled (`if (res.ok) {...}` with no else): a failed response is dropped without a word');
      const only = ts.isBlock(n.thenStatement) ? (n.thenStatement.statements.length === 1 ? n.thenStatement.statements[0]! : undefined) : n.thenStatement;
      if (neg && only && ((ts.isReturnStatement(only) && (!only.expression || only.expression.kind === ts.SyntaxKind.NullKeyword || only.expression.getText(sf) === 'undefined')) || ts.isContinueStatement(only))) {
        add(n, 'g', 'a failed response is dropped without a word: show the error (or log it, for a polled tick)');
      }
    }
    ts.forEachChild(n, visitS);
  };
  visitS(sf);

}
