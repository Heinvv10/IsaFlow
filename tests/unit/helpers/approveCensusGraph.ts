/**
 * The approve / post census's analyser (#1656, round 3): a TRANSITIVE call graph over the real TypeScript program, so a
 * route that reaches a posting primitive through helpers is judged, and a gate must DOMINATE each dangerous call (sit
 * on every path to it inside the function), not merely appear somewhere in the file.
 *
 *  - A unit is a named function (declaration, method, or a variable holding an arrow/function expression). Calls are
 *    resolved with the type checker (aliases and barrel re-exports followed), so a call is attributed to its real
 *    declaration, not to a name. Anonymous callbacks belong to the unit around them.
 *  - Dangerous callee: a SINK (a posting / reversing / approving primitive, by declared name) or a unit already in D.
 *  - A unit is in D when one of its dangerous calls is not dominated by a gate call inside it (a unit whose every
 *    dangerous call is gated asks the Approve itself and does not need its callers to).
 *  - Dominated: a gate call (GATES, by callee name) in a PRECEDING statement of an enclosing statement list, in the
 *    condition of an enclosing if / switch / conditional / && / ||, or the file's default export is wrapped by one of
 *    ROUTE_WRAPPERS (withPayrollModule). A gate inside an `if` body or another `case` does not dominate a sibling branch.
 *  - A route file is BAD when a root unit (not called by another unit of the file; the handler) is in D.
 * A call passing `{ dryRun: true }` is not dangerous (every guard, no write).
 * Limits: dynamic dispatch, `await import()`, and calls through objects typed as interfaces are not followed; a gate whose
 * condition narrows (`a && await gate()`) is taken as dominating what follows it (the per-path tests pin the condition).
 */
import ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface CensusConfig {
  /** Absolute path -> text of a virtual project (the analyser's own tests); omit to read the real files. */
  virtualFiles?: Record<string, string>;
  /** Files to analyse as routes (absolute for virtual, repo-relative otherwise). */
  routeFiles: string[];
  /** Every file of the program (repo-relative, or the virtual paths). */
  programFiles: string[];
  sinks: readonly string[];
  gates: ReadonlySet<string>;
  routeWrappers: readonly string[];
}

export interface BadRoute { file: string; unit: string; sites: string[] }

interface Unit { key: string; file: string; name: string; node: ts.Node; calls: Call[] }
interface Call { node: ts.CallExpression; callee: string; target: Unit | null; sink: boolean; dominated: boolean }

const ROOT = process.cwd();

function host(opts: ts.CompilerOptions, virtualFiles?: Record<string, string>): ts.CompilerHost {
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

function options(virtual: boolean): ts.CompilerOptions {
  if (virtual) {
    return { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, types: [], noLib: true };
  }
  const cfg = ts.readConfigFile(resolve(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  return { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true, plugins: undefined, types: [], skipLibCheck: true };
}

const calleeName = (c: ts.CallExpression): string | null => {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

const isFn = (n: ts.Node) => ts.isFunctionLike(n);

/** A call passing an object literal with `dryRun: true` runs every guard and writes nothing: not a dangerous call. */
const isDryRun = (c: ts.CallExpression): boolean => c.arguments.some((a) => ts.isObjectLiteralExpression(a)
  && a.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'dryRun'
    && p.initializer.kind === ts.SyntaxKind.TrueKeyword));

/** Does `expr` evaluate a gate call, outside any nested function? */
function gateIn(expr: ts.Node | undefined, gates: ReadonlySet<string>): boolean {
  if (!expr) return false;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || isFn(n)) return;
    if (ts.isCallExpression(n)) { const nm = calleeName(n); if (nm && gates.has(nm)) { found = true; return; } }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

/** Does this statement, by itself, evaluate a gate before the next statement runs (conditions and initialisers only)? */
function stmtGates(s: ts.Statement, gates: ReadonlySet<string>): boolean {
  if (ts.isExpressionStatement(s)) return gateIn(s.expression, gates);
  if (ts.isIfStatement(s)) return gateIn(s.expression, gates);
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.some((d) => gateIn(d.initializer, gates));
  if (ts.isReturnStatement(s)) return gateIn(s.expression, gates);
  if (ts.isSwitchStatement(s)) return gateIn(s.expression, gates);
  return false;
}

function statementsOf(p: ts.Node): readonly ts.Statement[] | null {
  if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p)) return p.statements;
  if (ts.isCaseClause(p) || ts.isDefaultClause(p)) return p.statements;
  return null;
}

function dominated(call: ts.Node, stop: ts.Node, gates: ReadonlySet<string>): boolean {
  let child: ts.Node = call;
  for (let p = call.parent; p; child = p, p = p.parent) {
    const stmts = statementsOf(p);
    if (stmts) {
      const i = stmts.indexOf(child as ts.Statement);
      for (let k = 0; k < i; k++) if (stmtGates(stmts[k]!, gates)) return true;
    }
    if (ts.isIfStatement(p) && child !== p.expression && gateIn(p.expression, gates)) return true;
    if (ts.isSwitchStatement(p) && child !== p.expression && gateIn(p.expression, gates)) return true;
    if (ts.isConditionalExpression(p) && child !== p.condition && gateIn(p.condition, gates)) return true;
    if (ts.isBinaryExpression(p) && child === p.right
      && (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      && gateIn(p.left, gates)) return true;
    if (p === stop) break;
  }
  return false;
}

export interface Census { bad: BadRoute[]; dangerousRoutes: string[]; why: Record<string, string[]> }

export function analyse(cfg: CensusConfig): Census {
  const virtual = Boolean(cfg.virtualFiles);
  const opts = options(virtual);
  const files = cfg.programFiles.map((f) => (virtual ? f : resolve(ROOT, f)));
  const program = ts.createProgram({ rootNames: files, options: opts, host: host(opts, cfg.virtualFiles) });
  const checker = program.getTypeChecker();
  const sinkSet = new Set(cfg.sinks);
  const rel = (f: string) => (virtual ? f : f.replace(`${ROOT}/`, ''));

  // 1. units
  const units = new Map<ts.Node, Unit>();
  const moduleUnits = new Map<string, Unit>();
  const unitOfFile = (sf: ts.SourceFile): Unit => {
    let u = moduleUnits.get(sf.fileName);
    if (!u) { u = { key: `${rel(sf.fileName)}::<module>`, file: rel(sf.fileName), name: '<module>', node: sf, calls: [] }; moduleUnits.set(sf.fileName, u); }
    return u;
  };
  const add = (decl: ts.Node, name: string, sf: ts.SourceFile) => {
    units.set(decl, { key: `${rel(sf.fileName)}::${name}`, file: rel(sf.fileName), name, node: decl, calls: [] });
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    const walk = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.body) add(n, n.name?.text ?? 'default', sf);
      else if (ts.isMethodDeclaration(n) && n.body && ts.isIdentifier(n.name)) add(n, n.name.text, sf);
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) add(n, n.name.text, sf);
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }

  const declOf = (c: ts.CallExpression): ts.Node | null => {
    let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(c.expression) ? c.expression.name : c.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.declarations?.[0] ?? null;
  };
  const enclosing = (n: ts.Node): Unit | null => {
    for (let p = n.parent; p; p = p.parent) { const u = units.get(p); if (u) return u; }
    return null;
  };

  // 2. calls
  const wrapped = new Set<string>(); // files whose default export is gated by a route wrapper
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    if (cfg.routeWrappers.some((w) => sf.text.includes(`export default ${w}(`) || new RegExp(`export default[^;]*\\b${w}\\(`).test(sf.text))) wrapped.add(rel(sf.fileName));
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        const decl = declOf(n);
        const target = decl ? (units.get(decl) ?? null) : null;
        const sink = name !== null && sinkSet.has(name);
        if ((target || sink) && !isDryRun(n)) {
          const u = enclosing(n) ?? unitOfFile(sf);
          u.calls.push({ node: n, callee: name ?? '?', target, sink, dominated: dominated(n, u.node, cfg.gates) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // 3. fixpoint: D
  const all = [...units.values(), ...moduleUnits.values()];
  const D = new Set<Unit>();
  for (let changed = true; changed;) {
    changed = false;
    for (const u of all) {
      if (D.has(u) || wrapped.has(u.file)) continue;
      if (u.calls.some((c) => (c.sink || (c.target && D.has(c.target))) && !c.dominated)) { D.add(u); changed = true; }
    }
  }

  // 4. routes: a root unit in D
  const calledInFile = new Set<Unit>();
  for (const u of all) for (const c of u.calls) if (c.target && c.target.file === u.file && c.target !== u) calledInFile.add(c.target);
  const routes = new Set(cfg.routeFiles);
  const bad: BadRoute[] = [];
  const dangerousRoutes = new Set<string>();
  for (const u of all) {
    if (routes.has(u.file) && u.calls.some((c) => c.sink || (c.target && D.has(c.target)))) dangerousRoutes.add(u.file);
    if (!D.has(u) || !routes.has(u.file) || calledInFile.has(u)) continue;
    const sites = u.calls.filter((c) => (c.sink || (c.target && D.has(c.target))) && !c.dominated)
      .map((c) => `${c.callee}@${rel(c.node.getSourceFile().fileName)}:${c.node.getSourceFile().getLineAndCharacterOfPosition(c.node.getStart()).line + 1}`);
    bad.push({ file: u.file, unit: u.name, sites });
  }
  // For a human following a finding: each dangerous unit's ungated dangerous calls, as callee -> the unit it resolves to.
  const why: Record<string, string[]> = {};
  for (const u of D) {
    why[u.key] = u.calls.filter((c) => (c.sink || (c.target && D.has(c.target))) && !c.dominated)
      .map((c) => `${c.callee}${c.target ? ` -> ${c.target.key}` : ' (primitive)'}`);
  }
  return { bad, dangerousRoutes: [...dangerousRoutes].sort(), why };
}

export const readTracked = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
