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

/** A bare phrase, with only filler after it ("Something went wrong - try again", "Failed.", "Network error"). */
const BARE = /^\s*(failed|error|unknown error( occurred)?|unexpected error( occurred)?|request failed|something went wrong|server error|network error|an (unexpected )?error (has )?occurred)\b[\s.,!?:;\u2013\u2014-]*(please\s+)?(try again( later)?)?[\s.!?]*$/i;
/** A fallback that is not a sentence about what failed: assertOk / apiJson / apiErrorMessage arguments (what an empty 5xx shows). */
const BAD_FALLBACK = (t: string) => BARE.test(t) || /^\s*(failed|error)\b/i.test(t) || /\bfailed\s*[.!]?\s*$/i.test(t) || /^\s*could not complete:/i.test(t);
const MSG_KEYS = /(message|text|error|msg|description|title|detail|payload|reason)$/i;
const JSX_MSG_ATTR = /^(message|error|errormessage|title|description|helpertext|hint)$/i;
/** Elements whose text is a label (a status badge, an option, a column heading), not a message. */
const LABEL_TAGS = /^(option|th|td|label|button|legend|dt)$/i;

export function analyzeMessages(cx: Ctx): void {
  const { checker, sf, add, refs, sym, canon } = cx;
  const literalTyped = (n: ts.Node): boolean => {
    const t = checker.getContextualType(n as ts.Expression);
    if (!t) return false;
    const parts = (t.isUnion() ? t.types : [t]).filter((p) => p.getCallSignatures().length === 0);   // SetStateAction<S> = S | (prev => S)
    return parts.length > 0 && parts.every((p) => !!(p.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
  };
  const comparisonish = (p: ts.Node) =>
    (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind))
    || ts.isCaseClause(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || (ts.isJsxAttribute(p) && !JSX_MSG_ATTR.test(p.name.getText(sf))) || ts.isElementAccessExpression(p);
  /** A branch of `cond ? 'Failed' : 'Sent'` where cond compares to that same word: a status label, not a message. */
  const statusLabel = (n: ts.Node): boolean => {
    const p = n.parent;
    if (!p || !ts.isConditionalExpression(p) || p.condition === n) return false;
    const word = (n as ts.StringLiteral).text?.trim().toLowerCase();
    let hit = false;
    const v = (m: ts.Node) => { if (ts.isStringLiteralLike(m) && m.text.trim().toLowerCase() === word) hit = true; ts.forEachChild(m, v); };
    v(p.condition);
    return hit;
  };
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
        const callee = canon(p.expression);
        if (/^new /.test(p.getText(sf)) || ts.isNewExpression(p)) return /(Error)$/.test(callee);
        return SINK.test(callee) || /(^|\.)(assertOk|apiErrorMessage)$/.test(callee) || (callee === 'apiJson' && p.arguments[2] === cur);
      }
      if (ts.isReturnStatement(p) || ts.isThrowStatement(p)) return true;
      if (ts.isArrowFunction(p) && p.body === cur) return true;
      if (ts.isVariableDeclaration(p) && p.initializer === cur) return !p.type;
      if (ts.isPropertyAssignment(p) && p.initializer === cur) return MSG_KEYS.test(p.name.getText(sf));
      if (ts.isJsxAttribute(p)) return JSX_MSG_ATTR.test(p.name.getText(sf));
      if (ts.isJsxExpression(p) || ts.isJsxElement(p) || ts.isJsxFragment(p)) return true;
      return false;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) { if (BARE.test(n.text.replace(/\s+/g, ' ')) && /^\s*[A-Z]/.test(n.text) && !(ts.isJsxElement(n.parent) && LABEL_TAGS.test(n.parent.openingElement.tagName.getText(sf))) && !(/:\s*$/.test(n.text) && ts.isJsxElement(n.parent) && n.parent.children[n.parent.children.indexOf(n as ts.JsxChild) + 1] && ts.isJsxExpression(n.parent.children[n.parent.children.indexOf(n as ts.JsxChild) + 1]!))) add(n, 'b', `JSX text ${JSON.stringify(n.text.trim())}: say what could not be done`); }
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !inLog(n, sf) && !comparisonish(n.parent) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
      const t = n.text.trim();
      const fallbackArg = ts.isCallExpression(n.parent) && ts.isIdentifier(n.parent.expression) && n.parent.arguments[({ apiJson: 2, assertOk: 1, apiErrorMessage: 1 } as Record<string, number>)[canon(n.parent.expression)] ?? -1] === n;   // reported once, below, as a fallback
      if ((BARE.test(t) || /^HTTP$/i.test(t)) && !literalTyped(n) && !statusLabel(n) && !fallbackArg && reachesPerson(n)) add(n, 'b', `bare message ${JSON.stringify(n.text)}: say what could not be done`);
    } else if (ts.isTemplateExpression(n) && !inLog(n, sf) && !comparisonish(n.parent)) {
      const head = n.head.text.trim();
      const status = n.templateSpans.some((s) => { const e = unwrap(s.expression); return ts.isPropertyAccessExpression(e) && /^status(Text)?$/.test(e.name.text) && isResponseType(checker, checker.getTypeAtLocation(e.expression)); });
      if ((/^(failed|error)\s*:?$/i.test(head) || /\bHTTP\s*$/i.test(n.head.text) || status) && !literalTyped(n) && reachesPerson(n)) add(n, 'b', 'a status code or a bare "Failed: ${x}" reaches a person: say what could not be done');
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = canon(n.expression);
      if (name === 'apiJson' && n.arguments.length < 3) add(n, 'b', 'apiJson without a failure sentence (3rd argument): a failed request would read "Request to /api/... failed"');
      const at = name === 'apiJson' ? 2 : name === 'assertOk' || name === 'apiErrorMessage' ? 1 : -1;   // the fallback an empty 5xx / 502 shows
      const fb = at >= 0 ? n.arguments[at] : undefined;
      if (fb && (ts.isStringLiteralLike(fb)) && BAD_FALLBACK(fb.text)) add(fb, 'b', `the fallback sentence ${JSON.stringify(fb.text)} does not say what failed: it is what a 502 or an empty 500 shows (say 'Could not <do the thing> - try again')`);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && !inLog(n, sf) && !ts.isBinaryExpression(n.parent)) {
      // 'Request failed with status ' + res.status
      const parts: ts.Node[] = []; const flat = (m: ts.Node) => { if (ts.isBinaryExpression(m) && m.operatorToken.kind === ts.SyntaxKind.PlusToken) { flat(m.left); flat(m.right); } else parts.push(m); }; flat(n);
      const st = parts.some((e) => { const u = unwrap(e); return ts.isPropertyAccessExpression(u) && /^status(Text)?$/.test(u.name.text) && isResponseType(checker, checker.getTypeAtLocation(u.expression)); });
      if (st && parts.some((e) => ts.isStringLiteralLike(e)) && reachesPerson(n)) add(n, 'b', 'a status code concatenated into a message reaches a person: say what could not be done');
    }
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
      if (d && ts.isVariableDeclaration(d) && d.initializer) {
        let init = unwrap(d.initializer);
        if (ts.isCallExpression(init) && /^(useCallback|useMemo)$/.test(init.expression.getText(sf)) && init.arguments[0]) init = unwrap(init.arguments[0]);   // const onErr = useCallback((e) => ..., [])
        if (isFn(init)) return init as ts.FunctionLikeDeclaration;
      }
    }
    return undefined;
  };
  const errSyms: Array<{ s: ts.Symbol; scope: ts.Node }> = [];
  const addBinding = (name: ts.BindingName | undefined, scope: ts.Node) => {
    if (!name) return;
    if (ts.isIdentifier(name)) { const s = sym(name); if (s) errSyms.push({ s, scope }); }
    else for (const el of name.elements) if (ts.isBindingElement(el)) addBinding(el.name, scope);
  };
  const addHandler = (e: ts.Expression | undefined) => {
    const f = resolveFn(e);
    if (f && f.parameters[0]) addBinding(f.parameters[0].name, f);
    // .catch(setErr) with `const [error, setErr] = useState(..)`: the state variable now holds the raw error
    const u = e && unwrap(e); const d = u && ts.isIdentifier(u) ? sym(u)?.valueDeclaration : undefined;
    if (d && ts.isBindingElement(d) && ts.isArrayBindingPattern(d.parent) && d.parent.elements[1] === d && ts.isVariableDeclaration(d.parent.parent)
      && d.parent.parent.initializer && /^useState\b/.test(unwrap(d.parent.parent.initializer).getText(sf))) {
      const first = d.parent.elements[0];
      if (first && ts.isBindingElement(first)) addBinding(first.name, sf);
    }
  };
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
  /** `err instanceof BgError ? err.message : ..`: a class of the code's own, whose messages are written as sentences. */
  const narrowedToOwnError = (n: ts.Node): boolean => {
    for (let q = n.parent; q && !isFn(q); q = q.parent) {
      if ((ts.isConditionalExpression(q) || ts.isIfStatement(q)) && q.parent) {
        const cond = ts.isConditionalExpression(q) ? q.condition : q.expression;
        let own = false; const v = (m: ts.Node) => { if (ts.isBinaryExpression(m) && m.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && !/^(Error|TypeError|RangeError|DOMException)$/.test(m.right.getText(sf))) own = true; ts.forEachChild(m, v); };
        v(cond);
        if (own) return true;
      }
    }
    return false;
  };
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
      // const { message } = err as Error: the destructured name is the raw text
      if (ts.isVariableDeclaration(p) && p.initializer === w && ts.isObjectBindingPattern(p.name)) { for (const el of p.name.elements) if ((el.propertyName ?? el.name).getText(sf) === 'message') addBinding(el.name, scope); continue; }
      // handed to a local function (handleError(err)): follow the parameter one level
      if (ts.isCallExpression(p) && p.arguments.includes(w as ts.Expression) && depth < 3) {
        const f = resolveFn(p.expression as ts.Expression); const prm = f && f.parameters[p.arguments.indexOf(w as ts.Expression)];
        if (f && prm && ts.isIdentifier(prm.name)) { const s = sym(prm.name); if (s) { checkUses(s, f, depth + 1); continue; } }
      }
      let raw = '';
      if (ts.isPropertyAccessExpression(p) && p.expression === w && /^(message|stack|toString|cause)$/.test(p.name.text)) raw = `.${p.name.text}`;
      else if (ts.isElementAccessExpression(p) && p.expression === w && ts.isStringLiteralLike(p.argumentExpression) && /^(message|stack)$/.test(p.argumentExpression.text)) raw = `['${p.argumentExpression.text}']`;
      else if (ts.isCallExpression(p) && p.arguments.includes(w as ts.Expression) && /^(String|JSON\.stringify)$/.test(p.expression.getText(sf))) raw = p.expression.getText(sf);
      else if (ts.isTemplateSpan(p)) raw = 'a template';
      else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) raw = 'string concatenation';
      else if (ts.isCallExpression(p) && p.arguments.includes(w as ts.Expression) && SINK.test(p.expression.getText(sf)) && !/apiErrorMessage/.test(p.expression.getText(sf))) raw = 'the error object passed to a message sink';
      else if (ts.isBindingElement(id.parent.parent?.parent ?? id)) raw = '';
      if (raw && raw !== 'the error object passed to a message sink' && !reachesPerson(ts.isPropertyAccessExpression(p) && ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : p)) raw = '';   // `(err as Error).message.includes('aborted')` is read, not shown
      if (!raw) { if (!ts.isIdentifier(id.parent) && sym(id)?.valueDeclaration && ts.isBindingElement(sym(id)!.valueDeclaration!) && root === sym(id)) { /* destructured name used directly */ } continue; }
      if (apiErrType(w) || narrowedToOwnError(w)) continue;
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
