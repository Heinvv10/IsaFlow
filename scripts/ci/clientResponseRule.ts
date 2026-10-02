/**
 * clientResponseRule — the census gate for how client code reads an API response.
 *
 * `apiFetch` RESOLVES on 4xx/5xx, so every consumer must look at the status
 * before it trusts the body. Four classes of defect kept coming back, one review
 * round at a time (D2, 2026-10): this gate finds all four by syntax, so the next
 * one fails CI instead of the next review.
 *
 *   a  a response body read (`.json()` / `.text()` / `.blob()`) on a fetch /
 *      apiFetch result with no status check before it in the same function
 *      (`assertOk(res)`, `res.ok`, `res.status`), including `.then(r => r.json())`
 *   b  a user-visible fallback that is a bare "Failed" / "Error" or `HTTP ${...}`
 *   c  `err.message` / `String(err)` taken from a catch in a file that talks to
 *      the API, instead of `apiErrorMessage(err, '<sentence>')` (log calls exempt)
 *   d  a mutating fetch / apiFetch call (method POST|PUT|PATCH|DELETE) whose
 *      result is never checked
 *
 * Parsed with the TypeScript compiler, not by regex, so it follows scopes. It is
 * deliberately CONSERVATIVE in one direction: it would rather flag a harmless
 * line (pin it, with a reason) than miss a real one. Limits, stated: a response
 * handed to a helper that is declared elsewhere is not followed; a `method`
 * held in a variable is not seen; a status check that exists but sits on a
 * different code path than the read counts as a check.
 *
 * Pure: takes {file, text} pairs. The CLI (check-client-responses.ts) lists files
 * with git ls-files and applies the pins; tests/unit/ci/clientResponseRule.test.ts
 * holds the mutation counterexamples.
 */
import ts from 'typescript';

export type HitKind = 'a' | 'b' | 'c' | 'd';
export interface Hit { file: string; line: number; kind: HitKind; reason: string; lineText: string }

const FETCHERS = new Set(['apiFetch', 'fetch']);
const BODY_READS = new Set(['json', 'text', 'blob', 'arrayBuffer', 'formData']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BARE = /^\s*(failed|error)\s*[.!]?\s*$/i;

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'fetch' && ts.isIdentifier(e.expression) && e.expression.text === 'window' ? 'fetch' : '';
  return '';
}
const isFetchCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && FETCHERS.has(calleeName(n));

function unwrap(n: ts.Node): ts.Node {
  while (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
  return n;
}
const enclosingFn = (n: ts.Node): ts.Node | undefined => { for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p; return undefined; };
const calls = (root: ts.Node, pred: (c: ts.CallExpression) => boolean): ts.CallExpression[] => {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => { if (ts.isCallExpression(n) && pred(n)) out.push(n); ts.forEachChild(n, visit); };
  visit(root);
  return out;
};

/** Does `text` (a slice of a function before a read) show a status check of `v`? */
function checksStatus(fnNode: ts.Node, v: string, from: number, to: number): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || n.getStart() >= to) return;
    if (n.getEnd() > from) {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === v && (n.name.text === 'ok' || n.name.text === 'status')) found = true;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'assertOk' || n.expression.text === 'apiJson')
        && n.arguments.some((a) => ts.isIdentifier(unwrap(a)) && (unwrap(a) as ts.Identifier).text === v)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fnNode);
  return found;
}

/** Names bound to a fetch result inside `scope`: `const res = await apiFetch()`, `const [a, b] = await Promise.all([apiFetch(), ...])`. */
function fetchBindings(scope: ts.Node): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isIdentifier(n.name) && isFetchCall(init)) out.set(n.name.text, n.getEnd());
      if (ts.isArrayBindingPattern(n.name) && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)
        && init.expression.name.text === 'all' && init.arguments[0] && ts.isArrayLiteralExpression(init.arguments[0])) {
        init.arguments[0].elements.forEach((el, i) => {
          const b = n.name as ts.ArrayBindingPattern;
          const slot = b.elements[i];
          if (slot && ts.isBindingElement(slot) && ts.isIdentifier(slot.name) && isFetchCall(unwrap(el))) out.set(slot.name.text, n.getEnd());
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

export function analyzeFile(file: string, text: string): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  const hits: Hit[] = [];
  const add = (n: ts.Node, kind: HitKind, reason: string) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
    hits.push({ file, line: line + 1, kind, reason, lineText: (lines[line] ?? '').trim() });
  };
  const talksToApi = /\b(apiFetch|apiJson|assertOk)\b|\bfetch\(/.test(text);

  // ── (a) body read before a status check ────────────────────────────────────
  const reads = calls(sf, (c) => ts.isPropertyAccessExpression(c.expression) && BODY_READS.has(c.expression.name.text));
  for (const read of reads) {
    const target = unwrap((read.expression as ts.PropertyAccessExpression).expression);
    // inline: (await apiFetch(..)).json()
    if (isFetchCall(target)) { add(read, 'a', 'body read straight off a fetch result, no status check'); continue; }
    if (!ts.isIdentifier(target)) continue;
    const v = target.text;
    // promise chain: apiFetch(..).then(r => r.json())
    const cb = enclosingFn(read);
    if (cb && ts.isCallExpression(cb.parent) && ts.isPropertyAccessExpression(cb.parent.expression) && cb.parent.expression.name.text === 'then') {
      const param = (cb as ts.FunctionLikeDeclaration).parameters[0];
      if (param && ts.isIdentifier(param.name) && param.name.text === v) {
        let root: ts.Node = cb.parent.expression.expression; let viaFetch = false;
        for (;;) {
          const u = unwrap(root);
          if (isFetchCall(u)) { viaFetch = true; break; }
          if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression)) { root = u.expression.expression; continue; }
          break;
        }
        if (viaFetch && !checksStatus(cb, v, cb.getStart(), read.getStart())) add(read, 'a', 'body read in .then(r => r.json()) with no status check');
        continue;
      }
    }
    // variable bound to a fetch result in this function or an enclosing one
    for (let scope: ts.Node | undefined = cb; scope; scope = enclosingFn(scope)) {
      const bound = fetchBindings(scope).get(v);
      if (bound === undefined) continue;
      if (read.getStart() > bound && !checksStatus(scope, v, bound, read.getStart())) add(read, 'a', `\`${v}\` is read before any status check (assertOk / .ok / .status)`);
      break;
    }
  }

  // ── (b) bare fallbacks ────────────────────────────────────────────────────
  const inLog = (n: ts.Node) => { for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && /^(log|console|logger)\./.test(p.expression.getText(sf))) return true; return false; };
  const visitB = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && BARE.test(n.text) && !inLog(n)) {
      const p = n.parent;
      // Only where the text can reach a person: a message sink, a fallback operand, a message-like property. A state
      // value (`setState('error')`), a comparison or a type literal is not a message.
      const SINK = /(^|\.)(notify|toast|alert|assertOk|apiErrorMessage|Error|setError\w*|setMsg\w*|setMessage\w*|setToast\w*|setBanner\w*|setNotice\w*|showToast\w*|flash|show\w*)$/i;
      // climb out of `a ? 'x' : 'y'` / `a || 'x'` so the sink is judged on the whole expression
      let top: ts.Node = n;
      while ((ts.isConditionalExpression(top.parent) && top.parent.condition !== top) || ts.isParenthesizedExpression(top.parent)
        || (ts.isBinaryExpression(top.parent) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(top.parent.operatorToken.kind))) top = top.parent;
      const q = top.parent;
      const callee = (ts.isCallExpression(q) || ts.isNewExpression(q)) ? q.expression.getText(sf).replace(/\.(error|success|warning|info)$/, '') : '';
      const argAt = /(^|\.)(assertOk|apiErrorMessage)$/.test(callee) ? 1 : 0;   // the sentence is the 2nd argument of these two
      const sink = !!callee && SINK.test(callee) && (ts.isCallExpression(q) || ts.isNewExpression(q)) && q.arguments?.[argAt] === top;
      const operand = false;
      const prop = ts.isPropertyAssignment(q) && /^(message|text|error|msg|description|title|detail)$/.test(q.name.getText(sf));
      if (sink || operand || prop) add(n, 'b', `bare fallback ${JSON.stringify(n.text)}: say what could not be done`);
    }
    if (ts.isTemplateExpression(n) && /\bHTTP\s*$/.test(n.head.text) && !inLog(n)) add(n, 'b', 'user-visible `HTTP ${status}`');
    if (ts.isTemplateExpression(n) && n.templateSpans.some((s) => /\bHTTP\s*$/.test(s.literal.text)) && !inLog(n)) add(n, 'b', 'user-visible `HTTP ${status}`');
    ts.forEachChild(n, visitB);
  };
  visitB(sf);

  // ── (c) raw error text from a catch, in a file that talks to the API ──────
  if (talksToApi) {
    const catchUses = (v: string, block: ts.Node) => {
      const visit = (n: ts.Node) => {
        const isVar = (x: ts.Node) => ts.isIdentifier(x) && x.text === v;
        const raw = (ts.isPropertyAccessExpression(n) && isVar(n.expression) && n.name.text === 'message')
          || (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String' && n.arguments.some(isVar))
          || (ts.isTemplateSpan(n) && isVar(n.expression));
        if (raw && !inLog(n)) {
          let viaHelper = false;
          for (let p = n.parent; p && p !== block; p = p.parent) if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'apiErrorMessage') viaHelper = true;
          if (!viaHelper) add(n, 'c', `raw error text from catch \`${v}\`: use apiErrorMessage(${v}, '<plain sentence>')`);
        }
        ts.forEachChild(n, visit);
      };
      visit(block);
    };
    const visitC = (n: ts.Node) => {
      if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) catchUses(n.variableDeclaration.name.text, n.block);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch' && n.arguments[0] && isFn(n.arguments[0])) {
        const cbn = n.arguments[0] as ts.FunctionLikeDeclaration; const p0 = cbn.parameters[0];
        if (p0 && ts.isIdentifier(p0.name)) catchUses(p0.name.text, cbn.body ?? cbn);
      }
      ts.forEachChild(n, visitC);
    };
    visitC(sf);
  }

  // ── (d) mutating call whose result is never checked ───────────────────────
  for (const call of calls(sf, (c) => isFetchCall(c))) {
    const opts = call.arguments[1];
    if (!opts || !ts.isObjectLiteralExpression(opts)) continue;
    const m = opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method');
    if (!m || !(ts.isStringLiteral(m.initializer) || ts.isNoSubstitutionTemplateLiteral(m.initializer)) || !MUTATING.has(m.initializer.text.toUpperCase())) continue;
    let top: ts.Node = call;
    while (ts.isAwaitExpression(top.parent) || ts.isParenthesizedExpression(top.parent) || ts.isVoidExpression(top.parent) || ts.isConditionalExpression(top.parent)) top = top.parent;
    const p = top.parent;
    const fnNode = enclosingFn(call) ?? sf;
    let ok = false;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) ok = checksStatus(fnNode, p.name.text, p.getEnd(), fnNode.getEnd());
    else if (ts.isPropertyAccessExpression(p)) {
      // a promise chain: ok when some .then callback checks its response
      let chain: ts.Node = p.parent;
      while (chain.parent && (ts.isCallExpression(chain) || ts.isPropertyAccessExpression(chain))) chain = chain.parent;
      const text = chain.getText(sf);
      ok = /assertOk\(|\.ok\b|\.status\b/.test(text);
    } else if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isCallExpression(p) || ts.isArrayLiteralExpression(p) || ts.isBinaryExpression(p)) {
      ok = !ts.isArrayLiteralExpression(p) || /assertOk\(|\.ok\b|\.status\b/.test(fnNode.getText(sf));
      if (ts.isCallExpression(p)) ok = /^(assertOk|apiJson)$/.test(p.expression.getText(sf));
    }
    if (!ok) add(call, 'd', 'mutating call whose result is never checked (assertOk the response)');
  }

  const seen = new Set<string>();
  return hits.filter((h) => { const k = `${h.line}:${h.kind}:${h.reason}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function analyze(files: Array<{ file: string; text: string }>): Hit[] {
  return files.flatMap((f) => analyzeFile(f.file, f.text));
}
