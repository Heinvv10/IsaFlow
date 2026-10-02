/**
 * Classes b and c of the client-response gate: what text reaches a person.
 *   b  a bare / status-code message ("Failed", "Unknown error", "Request failed", "Something went wrong",
 *      `HTTP ${status}`, `Server returned ${status}`, "Failed: ${x}"), in JSX text or in any message
 *      context (a sink call argument, `new Error(..)`, a ||/??/?: operand, a return, a message-like
 *      property); and an apiJson call with no failure sentence (it would read "Request to /api/x failed")
 *   c  raw error text from a catch / .catch / .then(_, h) / onError handler: err.message, (err as Error).message,
 *      err['message'], toString(), String(err), JSON.stringify(err), 'x' + err, `${err}`, a destructured
 *      `{ message }`, an alias of the error, a named handler, or the error object itself passed to a sink.
 *      Not raw: apiErrorMessage(err, ..), log.* arguments, and a value the checker types as
 *      ApiRequestError / ApiEnvelopeError (its message IS the server's sentence).
 */
import ts from 'typescript';
import { isResponseType } from './clientResponseFlow';
import { type Ctx, SINK, contains, inLog, isFn, unwrap } from './clientResponseShared';

const BARE = /^\s*(failed|error|unknown error|unexpected error|request failed|something went wrong|server error|an error occurred|an error has occurred)\s*[.!?]*\s*$/i;
const MSG_KEYS = /^(message|text|error|errormessage|msg|description|title|detail|payload|reason)$/i;

export function analyzeMessages(cx: Ctx): void {
  const { checker, sf, add, refs, sym } = cx;
  const literalTyped = (n: ts.Node): boolean => {
    const t = checker.getContextualType(n as ts.Expression);
    if (!t) return false;
    const parts = (t.isUnion() ? t.types : [t]).filter((p) => p.getCallSignatures().length === 0);   // SetStateAction<S> = S | (prev => S)
    return parts.length > 0 && parts.every((p) => !!(p.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
  };
  const comparisonish = (p: ts.Node) =>
    (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind))
    || ts.isCaseClause(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isJsxAttribute(p) || ts.isElementAccessExpression(p);
  /** Does text at `n` reach a person? Climb operands and wrappers to the first real consumer. */
  const reachesPerson = (n: ts.Node): boolean => {
    let cur: ts.Node = n;
    for (let g = 0; g < 30; g++) {
      const p = cur.parent;
      if (!p) return false;
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p)) { cur = p; continue; }
      if (ts.isConditionalExpression(p) && p.condition !== cur) { cur = p; continue; }
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.AmpersandAmpersandToken) { cur = p; continue; }
        return false;
      }
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        const callee = p.expression.getText(sf);
        if (/^new /.test(p.getText(sf)) || ts.isNewExpression(p)) return /(Error)$/.test(callee);
        return SINK.test(callee) || /(^|\.)(assertOk|apiErrorMessage)$/.test(callee) || (callee === 'apiJson' && p.arguments[2] === cur);
      }
      if (ts.isReturnStatement(p) || ts.isThrowStatement(p)) return true;
      if (ts.isArrowFunction(p) && p.body === cur) return true;
      if (ts.isVariableDeclaration(p) && p.initializer === cur) return !p.type;
      if (ts.isPropertyAssignment(p) && p.initializer === cur) return MSG_KEYS.test(p.name.getText(sf));
      if (ts.isJsxExpression(p) || ts.isJsxElement(p) || ts.isJsxFragment(p)) return true;
      return false;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) { if (BARE.test(n.text) && /^\s*[A-Z]/.test(n.text) && !(ts.isJsxElement(n.parent) && n.parent.children.some((c) => ts.isJsxExpression(c)))) add(n, 'b', `JSX text ${JSON.stringify(n.text.trim())}: say what could not be done`); }
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !inLog(n, sf) && !comparisonish(n.parent) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
      const t = n.text.trim();
      if ((BARE.test(t) || /^HTTP$/i.test(t)) && !literalTyped(n) && reachesPerson(n)) add(n, 'b', `bare message ${JSON.stringify(n.text)}: say what could not be done`);
    } else if (ts.isTemplateExpression(n) && !inLog(n, sf) && !comparisonish(n.parent)) {
      const head = n.head.text.trim();
      const status = n.templateSpans.some((s) => { const e = unwrap(s.expression); return ts.isPropertyAccessExpression(e) && /^status(Text)?$/.test(e.name.text) && isResponseType(checker, checker.getTypeAtLocation(e.expression)); });
      if ((/^(failed|error)\s*:?$/i.test(head) || /\bHTTP\s*$/i.test(n.head.text) || status) && !literalTyped(n) && reachesPerson(n)) add(n, 'b', 'a status code or a bare "Failed: ${x}" reaches a person: say what could not be done');
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'apiJson' && n.arguments.length < 3) add(n, 'b', 'apiJson without a failure sentence (3rd argument): a failed request would read "Request to /api/... failed"');
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // ── (c) ───────────────────────────────────────────────────────────────────
  const resolveFn = (e: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined => {
    if (!e) return undefined;
    const u = unwrap(e);
    if (isFn(u)) return u;
    if (ts.isIdentifier(u)) {
      const d = sym(u)?.valueDeclaration;
      if (d && isFn(d)) return d;
      if (d && ts.isVariableDeclaration(d) && d.initializer && isFn(unwrap(d.initializer))) return unwrap(d.initializer) as ts.FunctionLikeDeclaration;
    }
    return undefined;
  };
  const errSyms: Array<{ s: ts.Symbol; scope: ts.Node }> = [];
  const addBinding = (name: ts.BindingName | undefined, scope: ts.Node) => {
    if (!name) return;
    if (ts.isIdentifier(name)) { const s = sym(name); if (s) errSyms.push({ s, scope }); }
    else for (const el of name.elements) if (ts.isBindingElement(el)) addBinding(el.name, scope);
  };
  const addHandler = (e: ts.Expression | undefined) => { const f = resolveFn(e); if (f && f.parameters[0]) addBinding(f.parameters[0].name, f); };
  const collect = (n: ts.Node): void => {
    if (ts.isCatchClause(n) && n.variableDeclaration) addBinding(n.variableDeclaration.name, n.block);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      if (n.expression.name.text === 'catch') addHandler(n.arguments[0]);
      if (n.expression.name.text === 'then') addHandler(n.arguments[1]);
    }
    if (ts.isPropertyAssignment(n) && /^(onError|onFailure|onFail|onRejected)$/.test(n.name.getText(sf))) addHandler(n.initializer);
    if (ts.isShorthandPropertyAssignment(n) && /^(onError|onFailure)$/.test(n.name.text)) addHandler(n.name);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const apiErrType = (n: ts.Node) => { const t = checker.getTypeAtLocation(n); return (t.isUnion() ? t.types : [t]).every((p) => /^Api(Request|Envelope)Error$/.test(p.symbol?.name ?? '')); };
  const seen = new Set<ts.Node>();
  const checkUses = (root: ts.Symbol, scope: ts.Node, depth: number) => {
    for (const id of refs(root)) {
      if (!contains(scope, id) || seen.has(id)) continue;
      seen.add(id);
      let w: ts.Node = id;
      while (ts.isParenthesizedExpression(w.parent) || ts.isAsExpression(w.parent) || ts.isNonNullExpression(w.parent)) w = w.parent;
      const p = w.parent;
      if (inLog(id, sf)) continue;
      // an alias: const e = err as Error
      if (ts.isVariableDeclaration(p) && p.initializer === w && ts.isIdentifier(p.name) && depth < 3) { const s = sym(p.name); if (s) checkUses(s, scope, depth + 1); continue; }
      let raw = '';
      if (ts.isPropertyAccessExpression(p) && p.expression === w && /^(message|stack|toString|cause)$/.test(p.name.text)) raw = `.${p.name.text}`;
      else if (ts.isElementAccessExpression(p) && p.expression === w && ts.isStringLiteralLike(p.argumentExpression) && /^(message|stack)$/.test(p.argumentExpression.text)) raw = `['${p.argumentExpression.text}']`;
      else if (ts.isCallExpression(p) && p.arguments.includes(w as ts.Expression) && /^(String|JSON\.stringify)$/.test(p.expression.getText(sf))) raw = p.expression.getText(sf);
      else if (ts.isTemplateSpan(p)) raw = 'a template';
      else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) raw = 'string concatenation';
      else if (ts.isCallExpression(p) && p.arguments.includes(w as ts.Expression) && SINK.test(p.expression.getText(sf)) && !/apiErrorMessage/.test(p.expression.getText(sf))) raw = 'the error object passed to a message sink';
      else if (ts.isBindingElement(id.parent.parent?.parent ?? id)) raw = '';
      if (!raw) { if (!ts.isIdentifier(id.parent) && sym(id)?.valueDeclaration && ts.isBindingElement(sym(id)!.valueDeclaration!) && root === sym(id)) { /* destructured name used directly */ } continue; }
      if (apiErrType(w)) continue;
      add(id, 'c', `raw error text (${raw}) from a failed request: use apiErrorMessage(err, '<plain sentence>')`);
    }
  };
  for (const { s, scope } of errSyms) {
    const d = s.valueDeclaration;
    if (d && ts.isBindingElement(d) && !ts.isCatchClause(d.parent?.parent ?? d)) {
      // a destructured `{ message }`: every use outside log / apiErrorMessage is the raw text
      for (const id of refs(s)) {
        if (!contains(scope, id) || inLog(id, sf)) continue;
        let q: ts.Node = id; let viaHelper = false;
        for (; q && q !== scope; q = q.parent) if (ts.isCallExpression(q) && /apiErrorMessage/.test(q.expression.getText(sf))) viaHelper = true;
        if (!viaHelper && id !== d.name) add(id, 'c', `raw error text (destructured \`${id.text}\`) from a failed request: use apiErrorMessage(err, '<plain sentence>')`);
      }
    } else checkUses(s, scope, 0);
  }
}
