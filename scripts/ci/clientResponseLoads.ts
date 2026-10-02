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
  const FLAG = /^set(\w*)(Loading|Saving|Busy|Submitting|Working|Running|Processing|Sending|Uploading|Downloading|Deleting|Updating|Creating|Fetching|Syncing|Importing|Exporting|Pending)\w*$/;
  const setterCalls = (root: ts.Node, name?: string): ts.CallExpression[] =>
    calls(root, (c) => ts.isIdentifier(c.expression) && (name ? c.expression.text === name : FLAG.test(c.expression.text)));
  const fnHasAwait = (fnNode: ts.Node) => { let a = false; const v = (n: ts.Node) => { if (ts.isAwaitExpression(n)) a = true; if (!a && !(isFn(n) && n !== fnNode)) ts.forEachChild(n, v); }; v(fnNode); return a; };
  /** Does the block leave the page without awaiting it (window.location.href = .., a bare or void router.push)? */
  const navigates = (blk: ts.Node): boolean => {
    let found = false;
    const v = (m: ts.Node) => {
      if (ts.isBinaryExpression(m) && m.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^(window\.)?location(\.href)?$/.test(m.left.getText(sf))) found = true;
      if (ts.isCallExpression(m) && /^(window\.)?location\.(assign|replace)$|^(router|Router)\.(push|replace)$/.test(m.expression.getText(sf)) && !ts.isAwaitExpression(m.parent)) found = true;
      if (!(isFn(m) && m !== blk)) ts.forEachChild(m, v);
    };
    v(blk);
    return found;
  };
  const visitE = (n: ts.Node) => {
    // the converse: `finally { setBusy(false) }` after a navigation that is not awaited re-enables the button mid-redirect
    if (ts.isTryStatement(n) && n.finallyBlock && navigates(n.tryBlock)) {
      const guarded = (c: ts.Node) => { for (let q = c.parent; q && q !== n.finallyBlock; q = q.parent) if (ts.isIfStatement(q) || ts.isConditionalExpression(q)) return true; return false; };   // `if (!navigating) setBusy(false)`
      for (const c of setterCalls(n.finallyBlock)) if (c.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword && !guarded(c)) add(c, 'e', `\`${(c.expression as ts.Identifier).text}(false)\` in a finally after a navigation that is not awaited: the button re-enables while the page is leaving (double submit); clear it in the catch only`);
    }
    if (isFn(n) && n.body && fnHasAwait(n)) {
      const own = (c: ts.Node) => enclosingFn(c) === n;
      const trues = setterCalls(n.body).filter((c) => own(c) && c.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword);
      for (const t of trues) {
        const name = (t.expression as ts.Identifier).text;
        let cleared = false;
        const clears = (blk: ts.Node) => setterCalls(blk, name).some((c) => c.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword);
        const visitF = (m: ts.Node) => {
          if (ts.isTryStatement(m) && m.finallyBlock && clears(m.finallyBlock)) cleared = true;
          // a flag kept set on purpose while the page navigates away is cleared in the catch only
          if (ts.isTryStatement(m) && m.catchClause && !m.finallyBlock && navigates(m.tryBlock) && clears(m.catchClause.block)) cleared = true;
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
  const isOkRead = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === 'ok' && ts.isIdentifier(e.expression);
  /** `!res.ok`, `res.status !== 200`, `res.status >= 400`, or any of them as a disjunct (`!res.ok || cancelled`). */
  const failureTest = (c: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(c)) return failureTest(c.expression);
    if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.BarBarToken) return failureTest(c.left) || failureTest(c.right);
    if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) return isOkRead(c.operand as ts.Expression);
    if (ts.isBinaryExpression(c)) {
      const op = c.operatorToken.kind; const l = c.left;
      const st = ts.isPropertyAccessExpression(l) && l.name.text === 'status' && ts.isIdentifier(l.expression);
      return st && (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.GreaterThanEqualsToken || op === ts.SyntaxKind.GreaterThanToken) && ts.isNumericLiteral(c.right);
    }
    return false;
  };
  const emptyValue = (e: ts.Expression | undefined) => !e || e.kind === ts.SyntaxKind.NullKeyword
    || /^(undefined|\[\]|\{\})$/.test(e.getText(sf));   // `return false` is a default answer ("not done yet"), `return []` an empty list
  /** A statement that says nothing to a person: a reset setter (`setLoading(false)`, `setRows([])`). */
  const quiet = (st: ts.Statement) => ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && ts.isIdentifier(st.expression.expression)
    && /^set[A-Z]/.test(st.expression.expression.text) && !/(Error|Msg|Message|Toast|Notice|Flash|Banner)/.test(st.expression.expression.text)
    && st.expression.arguments.every((a) => emptyValue(a as ts.Expression) || a.kind === ts.SyntaxKind.FalseKeyword);
  /** `if (!res.ok) notify.error('fixed sentence')`: the server's 4xx message (403 "only an admin", 400 refusal) is dropped. */
  const SAYS = /^(set\w*(error|err|msg|message|toast|notice|banner|flash|warning|alert)\w*|notify(\.\w+)?|toast(\.\w+)?|showToast|alert)$/i;
  const fixedMessage = (n: ts.IfStatement) => {
    const c = n.expression;
    if (!(ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken && isOkRead(c.operand as ts.Expression))) return false;
    const stmts = ts.isBlock(n.thenStatement) ? n.thenStatement.statements : [n.thenStatement];
    const text = n.thenStatement.getText(sf);
    if (/\.(json|text)\(|assertOk|apiErrorMessage|\.status\b|statusText|throw\b/.test(text)) return false;   // reads the body, or hands the status on
    return stmts.some((st) => ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && SAYS.test(st.expression.expression.getText(sf))
      && st.expression.arguments.some((a) => ts.isStringLiteralLike(a) && a.text.trim().length > 0));
  };
  const visitS = (n: ts.Node) => {
    if (ts.isIfStatement(n) && !n.elseStatement && fixedMessage(n)) add(n, 'g', 'a refused response shows a fixed sentence: the server\'s own 4xx message is dropped (assertOk(res, sentence) and show apiErrorMessage)');
    if (ts.isIfStatement(n) && !n.elseStatement) {
      const c = n.expression;
      const pos = isOkRead(c);
      const after = ts.isBlock(n.parent) ? n.parent.statements.slice(n.parent.statements.indexOf(n as ts.Statement) + 1) : [];
      const last = after.every(quiet);   // anything after it that speaks may handle the failure
      if (pos && last) add(n, 'g', 'only the success branch is handled (`if (res.ok) {...}` with no else): a failed response is dropped without a word');
      const stmts = ts.isBlock(n.thenStatement) ? n.thenStatement.statements : [n.thenStatement];
      const speaks = stmts.some((st) => !quiet(st) && !(ts.isReturnStatement(st) && emptyValue(st.expression)) && !ts.isContinueStatement(st));
      if (failureTest(c) && stmts.length > 0 && !speaks) add(n, 'g', 'a failed response is dropped without a word: show the error (or log it, for a polled tick)');
    }
    ts.forEachChild(n, visitS);
  };
  visitS(sf);
}
