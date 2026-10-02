/** Shared AST helpers for the client-response gate (see clientResponseRule.ts). */
import ts from 'typescript';

export type HitKind = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
export interface Hit { file: string; line: number; kind: HitKind; reason: string; lineText: string }
export type Add = (n: ts.Node, kind: HitKind, reason: string) => void;

export const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

export function unwrap(n: ts.Node): ts.Node {
  while (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  return n;
}
export const enclosingFn = (n: ts.Node): ts.Node | undefined => { for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p; return undefined; };
export const calls = (root: ts.Node, pred: (c: ts.CallExpression) => boolean): ts.CallExpression[] => {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => { if (ts.isCallExpression(n) && pred(n)) out.push(n); ts.forEachChild(n, visit); };
  visit(root);
  return out;
};
/** A call to fetch / apiFetch / window.fetch / globalThis.fetch, by name (the typed rule uses the type checker instead). */
export function isFetchCall(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n)) return false;
  const e = n.expression;
  if (ts.isIdentifier(e)) return e.text === 'apiFetch' || e.text === 'fetch';
  return ts.isPropertyAccessExpression(e) && e.name.text === 'fetch' && ts.isIdentifier(e.expression) && /^(window|globalThis|self)$/.test(e.expression.text);
}

/** What every typed analysis gets: the checker, the file, a hit sink and symbol references. */
export interface Ctx {
  checker: ts.TypeChecker;
  sf: ts.SourceFile;
  add: Add;
  /** Identifier nodes in this file that resolve to `sym`. */
  refs: (sym: ts.Symbol) => ts.Identifier[];
  sym: (n: ts.Node) => ts.Symbol | undefined;
}
export const contains = (a: ts.Node, b: ts.Node) => a.pos <= b.pos && b.end <= a.end;
/** log.* / console.* / logger.* calls: text there never reaches a person. */
export const inLog = (n: ts.Node, sf: ts.SourceFile): boolean => {
  for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && /^(log|console|logger)\./.test(p.expression.getText(sf))) return true;
  return false;
};
/** Callee text of the nearest call that has `n` among its arguments (climbing operands), if any. */
export const calleeText = (c: ts.CallExpression | ts.NewExpression, sf: ts.SourceFile) => c.expression.getText(sf);
/** Sinks that show text to a person. */
export const SINK = /(^|\.)(set\w*(error|err|msg|message|toast|notice|banner|flash|warning|alert|failure|reason)\w*|notify|toast|showtoast|show\w*|addtoast|enqueuesnackbar|snackbar|alert|onerror|onfailure|message|error|warning|flash|setstate|dispatch)(\.(error|success|warning|info|warn))?$/i;
