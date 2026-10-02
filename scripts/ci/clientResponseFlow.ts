/**
 * Classes a and d of the client-response gate, by TYPE and SYMBOL (not by name):
 *   a  a body read (.json/.text/.blob/.arrayBuffer/.formData) on a value the type checker says is a
 *      Response, with no status check that dominates it, tracked per declaration through aliases,
 *      .clone(), ternaries, destructuring, Promise.all/map and callback parameters
 *   d  a mutating request (method not provably GET/HEAD) whose result is never checked, followed through
 *      assignment, ternary, ||/&&, .then/.catch, Promise.all, .map callbacks and local wrapper functions;
 *      plus any other transport (axios, XMLHttpRequest, sendBeacon)
 * A status "check" is a condition (`if/?:/&&/||/while` on `res.ok` or `res.status`) or an AWAITED / returned
 * assertOk(res): a log argument, JSON text, or `void assertOk(...)` is not one.
 */
import ts from 'typescript';
import { type Ctx, calls, contains, enclosingFn, isFn, unwrap } from './clientResponseShared';

const BODY_READS = new Set(['json', 'text', 'blob', 'arrayBuffer', 'formData']);
const MUTATING_RE = /^(post|put|patch|delete)$/i;

export function isResponseType(c: ts.TypeChecker, t: ts.Type): boolean {
  const aw = c.getAwaitedType(t) ?? t;
  const parts = aw.isUnion() ? aw.types : [aw];
  return parts.some((p) => !!p.symbol && p.symbol.name === 'Response' && !(p.flags & ts.TypeFlags.Any));
}

/** Is `id` (a reference to a response symbol) used as a status check, and over which code does that check dominate? */
function checkOf(id: ts.Identifier): { node: ts.Node; mode: 'contains' | 'before' | 'if' } | undefined {
  const parent = id.parent;
  if (ts.isCallExpression(parent) && parent.arguments[0] === id && /(^|\.)assertOk$/.test(parent.expression.getText())) {
    let n: ts.Node = parent;
    for (;;) {
      const p = n.parent;
      if (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p)) { n = p; continue; }
      if (ts.isCallExpression(p) && /^Promise\.(all|allSettled)$/.test(p.expression.getText())) { n = p; continue; }
      if (ts.isAwaitExpression(p) || ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === n)) {
        let st: ts.Node = parent; while (st.parent && !ts.isStatement(st)) st = st.parent;
        return { node: st, mode: 'before' };
      }
      return undefined;
    }
  }
  if (!(ts.isPropertyAccessExpression(parent) && parent.expression === id && (parent.name.text === 'ok' || parent.name.text === 'status'))) return undefined;
  let n: ts.Node = parent; let fallback: ts.Node | undefined;
  for (;;) {
    const p = n.parent;
    if ((ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) || ts.isParenthesizedExpression(p)) { n = p; continue; }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        if (p.left === n && !fallback) fallback = p.right;
        n = p; continue;
      }
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
        || op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken
        || op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) { n = p; continue; }
      break;
    }
    if (ts.isReturnStatement(p) && p.expression === n) return fallback ? { node: fallback, mode: 'contains' } : { node: p, mode: 'before' };   // `return res.ok` hands the status to the caller
    if (ts.isIfStatement(p) && p.expression === n) return { node: p, mode: 'if' };
    if ((ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === n) return { node: p, mode: 'if' };
    if (ts.isConditionalExpression(p) && p.condition === n) return { node: p, mode: 'contains' };
    if (ts.isVariableDeclaration(p) && p.initializer === n) { let st: ts.Node = p; while (st.parent && !ts.isStatement(st)) st = st.parent; return { node: st, mode: 'before' }; }
    break;
  }
  return fallback ? { node: fallback, mode: 'contains' } : undefined;
}

function dominates(chk: { node: ts.Node; mode: string }, read: ts.Node): boolean {
  if (chk.mode === 'contains') return contains(chk.node, read);
  if (chk.mode === 'if' && contains(chk.node, read)) return true;
  return chk.node.end <= read.getStart() && !!chk.node.parent && contains(chk.node.parent, read);
}

export function analyzeFlow(cx: Ctx): void {
  const { checker, sf, add, refs, sym } = cx;
  const isResp = (n: ts.Node) => isResponseType(checker, checker.getTypeAtLocation(n));
  const aliasChain = (s: ts.Symbol): ts.Symbol[] => {
    const out = [s]; let cur: ts.Symbol | undefined = s;
    for (let i = 0; i < 4 && cur; i++) {
      const d = cur.valueDeclaration;
      if (d && ts.isVariableDeclaration(d) && d.initializer) {
        let init = unwrap(d.initializer);
        if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'clone') init = unwrap(init.expression.expression);
        if (ts.isIdentifier(init)) { cur = sym(init); if (cur) out.push(cur); continue; }
      }
      break;
    }
    return out;
  };

  // ── (a) ───────────────────────────────────────────────────────────────────
  for (const c of calls(sf, () => true)) {
    let recv: ts.Node | undefined;
    if (ts.isPropertyAccessExpression(c.expression) && BODY_READS.has(c.expression.name.text)) recv = c.expression.expression;
    else if (ts.isElementAccessExpression(c.expression) && ts.isStringLiteral(c.expression.argumentExpression) && BODY_READS.has(c.expression.argumentExpression.text)) recv = c.expression.expression;
    else if (ts.isIdentifier(c.expression) && BODY_READS.has(c.expression.text)) {
      const d = sym(c.expression)?.valueDeclaration;   // `const { json } = await apiFetch(); json()`
      if (d && ts.isBindingElement(d) && isResp(d.parent)) { add(c, 'a', 'body read through a destructured method of a response: nothing can have checked it'); continue; }
      continue;
    }
    if (!recv || !isResp(recv)) continue;
    let root = unwrap(recv);
    while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression) && root.expression.name.text === 'clone') root = unwrap(root.expression.expression);
    if (!ts.isIdentifier(root)) { add(c, 'a', 'body read off a response nobody can have checked (an inline call or an expression)'); continue; }
    const s = sym(root);
    if (!s) continue;
    let ok = false;
    for (const a of aliasChain(s)) {
      for (const id of refs(a)) { const chk = checkOf(id); if (chk && dominates(chk, c)) { ok = true; break; } }
      if (ok) break;
    }
    if (!ok) add(c, 'a', `\`${root.text}\` is read before any status check that dominates the read (assertOk awaited / .ok / .status in a condition)`);
  }

  // ── (d) ───────────────────────────────────────────────────────────────────
  const litMethod = (t: ts.Type): 'get' | 'mut' => {
    const parts = t.isUnion() ? t.types : [t];
    return parts.every((p) => (p.flags & ts.TypeFlags.StringLiteral && /^(get|head)$/i.test((p as ts.StringLiteralType).value)) || (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))) ? 'get' : 'mut';
  };
  const initMethod = (arg: ts.Expression | undefined): 'get' | 'mut' => {
    if (!arg) return 'get';
    const u = unwrap(arg);
    if (ts.isNewExpression(u) && /Request$/.test(u.expression.getText())) return initMethod(u.arguments?.[1]);
    if (ts.isObjectLiteralExpression(u)) {
      let res: 'get' | 'mut' = 'get';
      for (const pr of u.properties) {
        if (ts.isSpreadAssignment(pr)) { const st = checker.getTypeAtLocation(pr.expression); const mp2 = st.getProperty('method'); if (!mp2 || litMethod(checker.getTypeOfSymbolAtLocation(mp2, pr.expression)) === 'mut') res = 'mut'; continue; }
        const nm = pr.name && (ts.isIdentifier(pr.name) || ts.isStringLiteralLike(pr.name)) ? pr.name.text : undefined;
        if (nm !== 'method') continue;
        const valueNode = ts.isPropertyAssignment(pr) ? pr.initializer : ts.isShorthandPropertyAssignment(pr) ? pr.name : undefined;
        res = valueNode && litMethod(checker.getTypeAtLocation(valueNode)) === 'get' ? 'get' : 'mut';
      }
      return res;
    }
    const t = checker.getTypeAtLocation(u);
    const mp = t.getProperty('method');
    if (!mp) return t.flags & ts.TypeFlags.Any ? 'mut' : 'get';
    return litMethod(checker.getTypeOfSymbolAtLocation(mp, u));
  };
  const symChecked = (s: ts.Symbol, after: number): boolean => refs(s).some((id) => id.getStart() >= after && !!checkOf(id));
  const paramChecked = (fn: ts.Node | undefined): boolean => {
    if (!fn || !isFn(fn)) return false;
    const p0 = fn.parameters[0];
    if (!p0 || !ts.isIdentifier(p0.name)) return false;
    const s = sym(p0.name);
    return !!s && symChecked(s, p0.end);
  };
  const resolveFn = (e: ts.Expression): ts.Node | undefined => {
    const u = unwrap(e);
    if (isFn(u)) return u;
    if (ts.isIdentifier(u)) {
      const d = sym(u)?.valueDeclaration;
      if (d && isFn(d)) return d;
      if (d && ts.isVariableDeclaration(d) && d.initializer && isFn(unwrap(d.initializer))) return unwrap(d.initializer);
    }
    return undefined;
  };
  const collectionChecked = (s: ts.Symbol): boolean => refs(s).some((id) => {
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === id && ts.isCallExpression(p.parent) && p.parent.arguments[0]) return paramChecked(resolveFn(p.parent.arguments[0] as ts.Expression));
    if (ts.isForOfStatement(p) && p.expression === id && ts.isVariableDeclarationList(p.initializer)) {
      const d = p.initializer.declarations[0]; const vs = d && ts.isIdentifier(d.name) ? sym(d.name) : undefined;
      return !!vs && symChecked(vs, d!.end);
    }
    return false;
  });
  const writers = new Set<ts.Symbol>();
  const seenCalls = new Set<ts.Node>();
  const flow = (origin: ts.CallExpression): 'checked' | 'unchecked' => {
    let n: ts.Node = origin; let index: number | undefined;
    for (let guard = 0; guard < 40; guard++) {
      const p = n.parent;
      if (!p) return 'unchecked';
      if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isVoidExpression(p)) { n = p; continue; }
      if (ts.isConditionalExpression(p) && p.condition !== n) { n = p; continue; }
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken && p.right === n) { const l = unwrap(p.left); const s = ts.isIdentifier(l) ? sym(l) : undefined; return s && symChecked(s, p.end) ? 'checked' : 'unchecked'; }
        if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(op)) { n = p; continue; }
        return 'unchecked';
      }
      if (ts.isArrayLiteralExpression(p)) { index = p.elements.indexOf(n as ts.Expression); n = p; continue; }
      if (ts.isPropertyAccessExpression(p) && p.expression === n && ts.isCallExpression(p.parent)) {
        const cl = p.parent; const m = p.name.text;
        if (m === 'then') { const cb = cl.arguments[0] && resolveFn(cl.arguments[0]); return paramChecked(cb) ? 'checked' : 'unchecked'; }
        if (m === 'catch' || m === 'finally') { n = cl; continue; }
        return 'unchecked';
      }
      if (ts.isCallExpression(p)) {
        const callee = p.expression.getText(sf);
        if (/^Promise\.(all|allSettled|race)$/.test(callee)) { n = p; continue; }
        if (/(^|\.)assertOk$/.test(callee) && p.arguments[0] === n) {
          let k: ts.Node = p; for (;;) { const q = k.parent; if (ts.isParenthesizedExpression(q) || ts.isArrayLiteralExpression(q)) { k = q; continue; } return ts.isAwaitExpression(q) || ts.isReturnStatement(q) || (ts.isArrowFunction(q) && q.body === k) ? 'checked' : 'unchecked'; }
        }
        const fnArg = p.arguments.indexOf(n as ts.Expression);
        if (fnArg >= 0) { const f = resolveFn(p.expression as ts.Expression); const prm = f && isFn(f) ? f.parameters[fnArg] : undefined; const ps = prm && ts.isIdentifier(prm.name) ? sym(prm.name) : undefined; return ps && symChecked(ps, 0) ? 'checked' : 'unchecked'; }
        return 'unchecked';
      }
      if (ts.isVariableDeclaration(p) && p.initializer === n) {
        if (ts.isIdentifier(p.name)) { const s = sym(p.name); return s && (symChecked(s, p.end) || collectionChecked(s)) ? 'checked' : 'unchecked'; }
        if (ts.isObjectBindingPattern(p.name)) return p.name.elements.some((e) => /^(ok|status)$/.test(e.name.getText(sf))) ? 'checked' : 'unchecked';
        if (ts.isArrayBindingPattern(p.name)) {
          const el = index !== undefined ? p.name.elements[index] : undefined;
          if (el && ts.isBindingElement(el) && ts.isIdentifier(el.name)) { const s = sym(el.name); return s && symChecked(s, p.end) ? 'checked' : 'unchecked'; }
          return p.name.elements.every((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name) && !!sym(e.name) && symChecked(sym(e.name)!, p.end)) ? 'checked' : 'unchecked';
        }
        return 'unchecked';
      }
      if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === n)) {
        const fn = ts.isReturnStatement(p) ? enclosingFn(p) : p;
        if (!fn) return 'unchecked';
        const parentCall = fn.parent && ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn as ts.Expression) && ts.isPropertyAccessExpression(fn.parent.expression) && /^(map|flatMap)$/.test(fn.parent.expression.name.text) ? fn.parent : undefined;
        if (parentCall) { n = parentCall; continue; }
        let ws: ts.Symbol | undefined;
        if (ts.isFunctionDeclaration(fn) && fn.name) ws = sym(fn.name);
        else if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) ws = sym(fn.parent.name);
        if (ws) { writers.add(ws); return 'checked'; }
        return 'unchecked';
      }
      return 'unchecked';
    }
    return 'unchecked';
  };
  const report = (c: ts.CallExpression) => { if (!seenCalls.has(c)) { seenCalls.add(c); if (flow(c) === 'unchecked') add(c, 'd', 'a write whose result is never checked (assertOk the response; method not provably GET counts as a write)'); } };
  for (const c of calls(sf, () => true)) {
    const callee = c.expression.getText(sf);
    const fetcher = /^(apiFetch|fetch|(window|globalThis|self)\.fetch)$/.test(callee);
    const a0 = c.arguments[0] && unwrap(c.arguments[0]);
    if (fetcher && (a0 && ts.isNewExpression(a0) ? initMethod(a0) : initMethod(c.arguments[1])) === 'mut') report(c);
    else if (callee === 'apiJson' && initMethod(c.arguments[1]) === 'mut') {
      let n: ts.Node = c;
      while (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || ts.isVoidExpression(n.parent)) n = n.parent;
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.name.text === 'catch' && ts.isCallExpression(p.parent)) {
        const cb = p.parent.arguments[0] && resolveFn(p.parent.arguments[0] as ts.Expression);
        const swallow = !cb || !isFn(cb) || !cb.body || (ts.isBlock(cb.body) ? !cb.body.statements.some((s) => /\b(set[A-Z]\w*|notify|toast|showToast|alert|throw|onError)\b/.test(s.getText(sf)))
          : /^(undefined|null|void 0|\{\}|[0-9'"`].*)$/.test(cb.body.getText(sf).trim()));
        if (swallow) add(c, 'd', 'an apiJson write whose failure is swallowed in .catch(): the person is never told');
      }
    }
    if (/^(axios(\.\w+)?|\$\.(ajax|post|get)|navigator\.sendBeacon)$/.test(callee)) add(c, 'd', `another transport (${callee}): its responses bypass apiFetch/assertOk`);
  }
  const visitX = (n: ts.Node) => { if (ts.isNewExpression(n) && /^XMLHttpRequest$/.test(n.expression.getText(sf))) add(n, 'd', 'another transport (XMLHttpRequest): its responses bypass apiFetch/assertOk'); ts.forEachChild(n, visitX); };
  visitX(sf);
  // local wrappers that return a write: every call to them is a write whose result must be checked
  for (let pass = 0; pass < 3 && writers.size; pass++) {
    const before = writers.size;
    for (const w of [...writers]) for (const id of refs(w)) {
      const call = ts.isCallExpression(id.parent) && id.parent.expression === id ? id.parent : undefined;
      if (call) report(call);
    }
    if (writers.size === before) break;
  }
}
