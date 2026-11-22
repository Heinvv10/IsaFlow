/** The TypeScript program and AST helpers behind approveCensusGraph.ts (split out for the 300-line cap). */
import ts from 'typescript';
import { resolve } from 'path';

export const ROOT = process.cwd();

export function host(opts: ts.CompilerOptions, virtualFiles?: Record<string, string>): ts.CompilerHost {
  const base = ts.createCompilerHost(opts, true);
  if (!virtualFiles) return base;
  const v = (f: string) => virtualFiles[f] ?? virtualFiles[resolve(f)];
  return {
    ...base,
    fileExists: (f) => v(f) !== undefined || base.fileExists(f),
    directoryExists: (d) => Object.keys(virtualFiles).some((f) => f.startsWith(`${d}/`)) || (base.directoryExists?.(d) ?? false),
    readFile: (f) => v(f) ?? base.readFile(f),
    getSourceFile: (f, lang) => (v(f) !== undefined ? ts.createSourceFile(f, v(f)!, lang, true) : base.getSourceFile(f, lang)),
  };
}

export function options(virtual: boolean): ts.CompilerOptions {
  if (virtual) {
    return { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, types: [], noLib: true };
  }
  const cfg = ts.readConfigFile(resolve(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  return { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true, plugins: undefined, types: [], skipLibCheck: true };
}

/** The real program is built once per process for a given file list (the approve census and the payroll-read census share it). */
const programs = new Map<string, ts.Program>();
export function programFor(files: string[], virtualFiles?: Record<string, string>): ts.Program {
  const key = virtualFiles ? '' : files.join('|');
  const cached = key ? programs.get(key) : undefined;
  if (cached) return cached;
  const opts = options(Boolean(virtualFiles));
  const program = ts.createProgram({ rootNames: files, options: opts, host: host(opts, virtualFiles) });
  if (key) programs.set(key, program);
  return program;
}

export const calleeName = (c: ts.CallExpression): string | null => {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

export const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x)) x = x.expression;
  return x;
};

/** The initializer of `name` in an object literal (`name: x`, or the shorthand `name`, which is its own identifier). */
export function objectProp(o: ts.ObjectLiteralExpression, name: string): { initializer: ts.Expression; shorthand?: ts.ShorthandPropertyAssignment } | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return { initializer: p.name, shorthand: p };
  }
  return undefined;
}

/**
 * `census-exempt(<callee>, <census>): reason`: ONE census's exemption (`posting` or `payroll-read`). The census is REQUIRED
 * (#1670 breaker r12 M1): an unscoped marker exempted the call from both censuses, so a payroll-read reason silenced the posting
 * census. An unscoped `census-exempt(<callee>):` is no marker here, and approvePostEntryCensus fails on any left in the tree.
 */
const MARKER = /census-exempt\(([A-Za-z0-9_-]+),\s*(posting|payroll-read)\):\s*(\S[^\n*]*)/g;
/** Any `census-exempt(` without a census named, for the census that fails on them. */
export const UNSCOPED_MARKER = /census-exempt\((?![A-Za-z0-9_-]+,\s*(?:posting|payroll-read)\):)/;
export type MarkerScope = 'posting' | 'payroll-read';
const applies = (m: RegExpMatchArray, scope?: MarkerScope): boolean => scope === undefined || m[2] === scope;

/** Every `census-exempt(<callee>): reason` marker in a source file that applies to `scope`, with its line. */
export function markersIn(sf: ts.SourceFile, scope?: MarkerScope): Array<{ callee: string; line: number }> {
  const out: Array<{ callee: string; line: number }> = [];
  for (const m of sf.text.matchAll(MARKER)) if (applies(m, scope)) out.push({ callee: m[1]!, line: sf.getLineAndCharacterOfPosition(m.index!).line + 1 });
  return out;
}

/** The markers in the comments directly above the statement holding `node` that apply to `scope` (callee and line). */
export function markersAbove(node: ts.Node, scope?: MarkerScope): Array<{ callee: string; line: number }> {
  let stmt: ts.Node = node;
  while (stmt.parent && !ts.isStatement(stmt)) stmt = stmt.parent;
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, stmt.getFullStart()) ?? [];
  return ranges.flatMap((r) => [...sf.text.slice(r.pos, r.end).matchAll(MARKER)].filter((m) => applies(m, scope))
    .map((m) => ({ callee: m[1]!, line: sf.getLineAndCharacterOfPosition(r.pos + m.index!).line + 1 })));
}

/** A return / throw ends the path (a block ending in one does). */
export const exits = (s: ts.Statement | undefined): boolean => {
  if (!s) return false;
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true;
  return ts.isBlock(s) && s.statements.length > 0 && exits(s.statements[s.statements.length - 1]);
};

/** The initializer of a `const` an identifier names (the census reads a const's SQL text, or a bind's value, as if written in place). */
export type ConstResolver = (id: ts.Identifier) => ts.Expression | undefined;

/** `const` initializers, through the type checker (aliases are not followed: a const SQL text is read where the const is declared). */
export const constResolver = (checker: ts.TypeChecker): ConstResolver => (id) => {
  const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
  return d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && d.parent.flags & ts.NodeFlags.Const ? d.initializer : undefined;
};

/** A bind's static value: a string literal, or a const bound to one. Anything else is unknown (null). */
function literalOf(e: ts.Expression, resolveConst?: ConstResolver, depth = 0): string | null {
  const x = unwrap(e);
  if (ts.isStringLiteralLike(x)) return x.text;
  const init = ts.isIdentifier(x) && resolveConst && depth < 3 ? resolveConst(x) : undefined;
  return init ? literalOf(init, resolveConst, depth + 1) : null;
}
const bindText = (e: ts.Expression, r?: ConstResolver): string => { const v = literalOf(e, r); return v === null ? '?' : `'${v}'`; };

/** A template's text, each substitution read as its static value ('posted') where it has one, else `?` (#1670 breaker L1a). */
function templateOf(t: ts.TemplateLiteral, r?: ConstResolver): string {
  return ts.isNoSubstitutionTemplateLiteral(t) ? t.text
    : `${t.head.text}${t.templateSpans.map((sp) => `${bindText(sp.expression, r)}${sp.literal.text}`).join('')}`;
}

/** The text of a `.query()` first argument: a string, a template, or a const naming one (L1b); null when it is not static. */
function queryText(a: ts.Expression, r?: ConstResolver, depth = 0): string | null {
  const x = unwrap(a);
  if (ts.isStringLiteralLike(x)) return x.text;
  if (ts.isTemplateExpression(x)) return templateOf(x, r);
  const init = ts.isIdentifier(x) && r && depth < 3 ? r(x) : undefined;
  return init ? queryText(init, r, depth + 1) : null;
}

/**
 * The static SQL text of a node: a tagged template, and, when `queryCalls`, a `<x>.query(text, values?)` call (the pg client and pool
 * style). A bind with a static value reads as that value: `${'posted'}`, a const, or a `$n` whose values-array element is one.
 */
export function sqlTextOf(n: ts.Node, queryCalls: boolean, r?: ConstResolver): string | null {
  if (ts.isTaggedTemplateExpression(n)) return templateOf(n.template, r);
  if (!queryCalls || !ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'query') return null;
  const text = n.arguments[0] ? queryText(n.arguments[0], r) : null;
  const values = n.arguments[1] && ts.isArrayLiteralExpression(unwrap(n.arguments[1])) ? (unwrap(n.arguments[1]) as ts.ArrayLiteralExpression).elements : null;
  if (text === null || !values) return text;
  return text.replace(/\$(\d+)\b/g, (m, i: string) => {
    const el = values[Number(i) - 1];
    const v = el && !ts.isSpreadElement(el) ? literalOf(el, r) : null;
    return v === null ? m : `'${v}'`;
  });
}

/** A module RESOLVER: given its first argument's static value (null: not static), the module the gate asks. */
export type ModuleResolver = (literalArg: string | null) => string;
/** The module of a gate the census cannot read: it covers NOTHING (#1670 r13 L1), so a computed module never passes for 'any'. */
export const UNREADABLE = '?';

/** A static string value: a literal, or a const bound to one. */
function staticString(e: ts.Expression | undefined, r: ConstResolver, depth = 0): string | null {
  const x = e ? unwrap(e) : undefined;
  if (!x) return null;
  if (ts.isStringLiteralLike(x)) return x.text;
  const init = ts.isIdentifier(x) && depth < 3 ? r(x) : undefined;
  return init ? staticString(init, r, depth + 1) : null;
}

/**
 * A gate's module argument: a string literal; a call of a module RESOLVER (`resolvers`), which is given its own first argument
 * (r13 L2: returnApproveModule('EMP501') asks Payroll, not "some return's module"); either directly or through a const. Anything
 * else is UNREADABLE.
 */
export function moduleOfArg(arg: ts.Expression, resolvers: Readonly<Record<string, ModuleResolver>>, r: ConstResolver, depth = 0): string {
  const x = unwrap(arg);
  if (ts.isStringLiteralLike(x)) return x.text;
  const nm = ts.isCallExpression(x) ? calleeName(x) : null;
  if (nm !== null && Object.hasOwn(resolvers, nm)) return resolvers[nm]!(staticString((x as ts.CallExpression).arguments[0], r));
  const init = ts.isIdentifier(x) && depth < 3 ? r(x) : undefined;
  return init ? moduleOfArg(init, resolvers, r, depth + 1) : UNREADABLE;
}

/**
 * Does a gate for module `gate` cover a need for `need`? Equal modules do. '*' (a gate deciding per document) covers any but a
 * strict need. A resolved return gate 'returns:<m>' covers <m> and the form-agnostic 'returns'. UNREADABLE covers nothing.
 */
function gateCovers(gate: string, need: string, strict: ReadonlySet<string>): boolean {
  if (gate === UNREADABLE) return false;
  if (gate === need) return true;
  if (gate === '*') return !strict.has(need);
  return gate.startsWith('returns:') && (need === 'returns' || need === gate.slice('returns:'.length));
}

/** Every need covered by one of the gates ('*' needs: any gate the census can read). */
export function gatesCover(gates: ReadonlySet<string>, needs: Iterable<string>, strict: ReadonlySet<string>): boolean {
  const g = [...gates];
  return g.length > 0 && [...needs].every((m) => (m === '*' ? g.some((x) => x !== UNREADABLE) : g.some((x) => gateCovers(x, m, strict))));
}

/** A posting / approving SQL pattern and the module whose Approve it needs ('*': any gate). A bare RegExp is '*'. */
export type SqlPrimitive = RegExp | { re: RegExp; module: string };

/** The module the first matching primitive needs, or null when none matches. */
export function primitiveModule(prims: readonly SqlPrimitive[], text: string): string | null {
  for (const p of prims) if ((p instanceof RegExp ? p : p.re).test(text)) return p instanceof RegExp ? '*' : p.module;
  return null;
}

/** The calls that enclose `node` inside its own statement (a call nested in another call's arguments). */
export function callAncestors(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  for (let p = node.parent; p && !ts.isStatement(p); p = p.parent) if (ts.isCallExpression(p)) out.push(p);
  return out;
}
