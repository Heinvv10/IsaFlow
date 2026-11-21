/**
 * The approve / post census's analyser (#1656): a TRANSITIVE call graph over the real TypeScript program, so a route that reaches
 * a posting primitive through helpers is judged, and a gate must DOMINATE each dangerous call AND ask the right module.
 *
 *  - A unit is a named function (declaration, method, or a variable holding an arrow/function expression). Calls are resolved with
 *    the type checker (aliases and barrel re-exports followed). Anonymous callbacks belong to the unit around them.
 *  - Dangerous callee: a SINK (named; its module is enforced where a route calls it directly, '*' inside services), a unit running
 *    posting SQL (module '*'), or a unit already in D. A unit is in D when one of its dangerous calls is not covered; it needs the modules of those calls.
 *  - Covered: the gates that DOMINATE the call give modules that include each module the call needs ('*' on either side matches).
 *    A gate dominates only where its refusal is unconditional on the path to the call:
 *      refuse gate  `if (await refuse(...)) return|throw ...;`          covers the statements after it in the block
 *      allow gate   `if (!(await mayApprove(...))) return|throw ...;`   likewise (`!ident` of a const set from it too)
 *      assert gate  `await assertMayApprove(...);`                        likewise (it throws)
 *      allow gate as a condition: the call sits in the THEN branch of `if (... && allow)`, the true arm of `... && allow ? x : y`,
 *      or right of `&&` after it.
 *    NOT a gate: `if (cond && await refuse(...)) return;`, a bare `await mayApprove(...)` whose result is dropped, a gate in a sibling
 *    `case` or an `if` body, one after the call.
 *  - A route wrapped by a ROUTE_WRAPPERS name is gated for that wrapper's module for the whole file.
 *  - A call passing `{ dryRun: true }`, or an `allowReversal` whose value is a GATE RESULT (a gate call, or a variable set from one: the
 *    service refuses under its own row lock), is not dangerous. A literal, or any other value, is not a decision.
 *  - A PARAMETERISED sink whose gate depends on an argument is exempted per CALL SITE by a marker comment above its statement,
 *    `census-exempt(<callee>): reason` (the OUTERMOST call of that name in the statement; in the payroll-read census `census-exempt(sql)`
 *    binds the one SQL statement below it); used only while the call would otherwise be uncovered, else reported stale (staleMarkers).
 *  - A route file is BAD when a root unit (not called by another unit of the file; the handler) is in D.
 */
import ts from 'typescript';
import { resolve } from 'path';
import { calleeName, callAncestors, exits, markersAbove, markersIn, objectProp, programFor, ROOT, sqlTextOf, unwrap } from './approveCensusProgram';

export interface GateSpec { kind: 'refuse' | 'allow' | 'assert'; moduleArg?: number; module?: string }

export interface CensusConfig {
  /** Absolute path -> text of a virtual project (the analyser's own tests). */
  virtualFiles?: Record<string, string>;
  routeFiles: string[];
  programFiles: string[];
  /** Sink name -> the module whose Approve it needs ('*': any). */
  sinks: Readonly<Record<string, string>>;
  gates: Readonly<Record<string, GateSpec>>;
  routeWrappers: Readonly<Record<string, string>>;
  /** Static SQL text that makes the unit holding it a primitive (module '*'). */
  sqlPrimitives?: readonly RegExp[];
  /** A route unit running primitive SQL itself is dangerous unless wrapped, a gate dominates it, or a marker sits above it (#1670). */
  flagPrimitiveRoots?: boolean;
  queryCalls?: boolean; // also read `<x>.query('...')` (a static string or template) as SQL: both censuses
}

export interface BadRoute { file: string; unit: string; sites: string[] }
export interface Census { bad: BadRoute[]; dangerousRoutes: string[]; why: Record<string, string[]>; markersUsed: string[]; staleMarkers: string[] }
interface Unit { key: string; file: string; name: string; node: ts.Node; calls: Call[]; primitive: boolean; primSites: ts.Node[]; needs: Set<string> }
interface Call { node: ts.CallExpression; callee: string; target: Unit | null; sinkModule: string | null; gates: Set<string>; exempt: { line: number } | null }

export function analyse(cfg: CensusConfig): Census {
  const virtual = Boolean(cfg.virtualFiles);
  const files = cfg.programFiles.map((f) => (virtual ? f : resolve(ROOT, f)));
  const program = programFor(files, cfg.virtualFiles);
  const checker = program.getTypeChecker();
  const rel = (f: string) => (virtual ? f : f.replace(`${ROOT}/`, ''));
  const wrapperNames = Object.keys(cfg.routeWrappers);
  const routeSet = new Set(cfg.routeFiles); // sink modules bind where a route calls them

  // ── gate recognition ──────────────────────────────────────────────────────────────────────────
  const gateModule = (c: ts.CallExpression, spec: GateSpec): string => {
    if (spec.module !== undefined) return spec.module;
    const arg = spec.moduleArg !== undefined ? c.arguments[spec.moduleArg] : undefined;
    return arg && ts.isStringLiteralLike(arg) ? arg.text : '*';
  };
  const asGate = (e: ts.Expression): { spec: GateSpec; module: string } | null => {
    const x = unwrap(e);
    if (!ts.isCallExpression(x)) return null;
    const nm = calleeName(x);
    const spec = nm ? cfg.gates[nm] : undefined;
    return spec ? { spec, module: gateModule(x, spec) } : null;
  };
  /** `const ok = await mayApprove(...)`: the allow gate an identifier stands for. */
  const identGate = (id: ts.Identifier): { spec: GateSpec; module: string } | null => {
    const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
    return decl && ts.isVariableDeclaration(decl) && decl.initializer ? asGate(decl.initializer) : null;
  };
  const gateOf = (e: ts.Expression, shorthand?: ts.ShorthandPropertyAssignment): { spec: GateSpec; module: string } | null => {
    const x = unwrap(e);
    if (shorthand) { // `{ allowReversal }`: the symbol of the VARIABLE, not of the property
      const decl = checker.getShorthandAssignmentValueSymbol(shorthand)?.declarations?.[0];
      return decl && ts.isVariableDeclaration(decl) && decl.initializer ? asGate(decl.initializer) : null;
    }
    return ts.isIdentifier(x) ? identGate(x) : asGate(x);
  };

  /** `{ dryRun: true }`, or `{ allowReversal: <a gate result> }`: not a write the caller must gate. */
  const selfGuarded = (c: ts.CallExpression): boolean => c.arguments.some((a) => {
    if (!ts.isObjectLiteralExpression(a)) return false;
    const dry = objectProp(a, 'dryRun');
    if (dry && dry.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    const rev = objectProp(a, 'allowReversal');
    return rev !== undefined && gateOf(rev.initializer, rev.shorthand) !== null;
  });

  /** Modules whose gate is certainly PASSED when `e` is true (an allow gate, or a negated refuse gate, joined by &&). */
  const trueMeans = (e: ts.Expression | undefined, depth = 0): string[] => {
    if (!e) return [];
    const x = unwrap(e);
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...trueMeans(x.left, depth), ...trueMeans(x.right, depth)];
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
      const g = gateOf(x.operand);
      return g && g.spec.kind === 'refuse' ? [g.module] : [];
    }
    if (ts.isIdentifier(x)) {
      // `const posted = autoPost && !held` / `const ok = await mayApprove(...)`: what the variable's value being true means.
      const decl = checker.getSymbolAtLocation(x)?.declarations?.[0];
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && depth < 4) return trueMeans(decl.initializer, depth + 1);
      return [];
    }
    const g = gateOf(x);
    return g && g.spec.kind === 'allow' ? [g.module] : [];
  };
  /** Modules whose gate is certainly passed when `e` is FALSE (a refuse gate, or a negated allow gate, joined by ||). */
  const falseMeans = (e: ts.Expression | undefined): string[] => {
    if (!e) return [];
    const x = unwrap(e);
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...falseMeans(x.left), ...falseMeans(x.right)];
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
      const g = gateOf(x.operand);
      return g && g.spec.kind === 'allow' ? [g.module] : [];
    }
    const g = gateOf(x);
    return g && g.spec.kind === 'refuse' ? [g.module] : [];
  };
  /** The modules a STATEMENT leaves passed for everything after it in its block. */
  const statementGates = (s: ts.Statement): string[] => {
    if (ts.isIfStatement(s) && exits(s.thenStatement)) return falseMeans(s.expression);
    if (ts.isExpressionStatement(s)) {
      const g = asGate(s.expression);
      return g && g.spec.kind === 'assert' ? [g.module] : [];
    }
    return [];
  };
  const dominating = (call: ts.Node, stop: ts.Node): Set<string> => {
    const out = new Set<string>();
    let child: ts.Node = call;
    for (let p = call.parent; p; child = p, p = p.parent) {
      if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
        const stmts = p.statements;
        for (let k = 0; k < stmts.indexOf(child as ts.Statement); k++) statementGates(stmts[k]!).forEach((m) => out.add(m));
      }
      if (ts.isIfStatement(p)) {
        if (child === p.thenStatement) trueMeans(p.expression).forEach((m) => out.add(m));
        else if (child === p.elseStatement) falseMeans(p.expression).forEach((m) => out.add(m));
      }
      if (ts.isConditionalExpression(p)) {
        if (child === p.whenTrue) trueMeans(p.condition).forEach((m) => out.add(m));
        else if (child === p.whenFalse) falseMeans(p.condition).forEach((m) => out.add(m));
      }
      if (ts.isBinaryExpression(p) && child === p.right) {
        if (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) trueMeans(p.left).forEach((m) => out.add(m));
        else if (p.operatorToken.kind === ts.SyntaxKind.BarBarToken) falseMeans(p.left).forEach((m) => out.add(m));
      }
      if (p === stop) break;
    }
    return out;
  };
  // ── units ─────────────────────────────────────────────────────────────────────────────────────
  const units = new Map<ts.Node, Unit>();
  const moduleUnits = new Map<string, Unit>();
  const unitOfFile = (sf: ts.SourceFile): Unit => {
    let u = moduleUnits.get(sf.fileName);
    if (!u) { u = { key: `${rel(sf.fileName)}::<module>`, file: rel(sf.fileName), name: '<module>', node: sf, calls: [], primitive: false, primSites: [], needs: new Set() }; moduleUnits.set(sf.fileName, u); }
    return u;
  };
  const add = (decl: ts.Node, name: string, sf: ts.SourceFile) => {
    units.set(decl, { key: `${rel(sf.fileName)}::${name}`, file: rel(sf.fileName), name, node: decl, calls: [], primitive: false, primSites: [], needs: new Set() });
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

  // ── calls, and the units that run posting SQL ─────────────────────────────────────────────────
  const wrapped = new Map<string, string>(); // file -> the module its route wrapper gates
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    for (const w of wrapperNames) {
      if (new RegExp(`export default[^;]*\\b${w}\\(`).test(sf.text)) wrapped.set(rel(sf.fileName), cfg.routeWrappers[w]!);
    }
    const visit = (n: ts.Node) => {
      const text = cfg.sqlPrimitives ? sqlTextOf(n, cfg.queryCalls === true) : null;
      if (text !== null && cfg.sqlPrimitives!.some((re) => re.test(text))) {
        const u = enclosing(n) ?? unitOfFile(sf);
        u.primitive = true;
        u.primSites.push(n);
      }
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        const decl = declOf(n);
        const target = decl ? (units.get(decl) ?? null) : null;
        // A sink's module binds where a route calls it; in the service layer a chain mixes modules, so a helper needs 'any gate'.
        const sinkModule = name !== null && Object.hasOwn(cfg.sinks, name) ? (routeSet.has(rel(sf.fileName)) ? cfg.sinks[name]! : '*') : null;
        // A marker binds to the OUTERMOST call of that name in its statement: a same-named call nested inside it is not exempted.
        const outermost = name !== null && !callAncestors(n).some((a) => calleeName(a) === name);
        const exempt = outermost ? (markersAbove(n).find((m) => m.callee === name) ?? null) : null;
        if ((target || sinkModule !== null) && !selfGuarded(n)) {
          const u = enclosing(n) ?? unitOfFile(sf);
          u.calls.push({ node: n, callee: name ?? '?', target, sinkModule, gates: dominating(n, u.node), exempt });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // ── fixpoint: D, with the modules each dangerous unit needs ───────────────────────────────────
  const all = [...units.values(), ...moduleUnits.values()];
  const D = new Set<Unit>();
  const needsOfCall = (c: Call): Set<string> | null => {
    if (c.sinkModule !== null) return new Set([c.sinkModule]);
    if (c.target && (D.has(c.target) || c.target.primitive)) return c.target.primitive && !D.has(c.target) ? new Set(['*']) : c.target.needs;
    return null;
  };
  const rawCovered = (c: Call, file: string, needs: Set<string>): boolean => {
    const g = new Set(c.gates);
    const w = wrapped.get(file);
    if (w) g.add(w);
    if (g.size === 0) return false;
    if (g.has('*')) return true;
    return [...needs].filter((m) => m !== '*').every((m) => g.has(m));
  };
  const covered = (c: Call, file: string, needs: Set<string>): boolean => c.exempt !== null || rawCovered(c, file, needs);
  for (let changed = true; changed;) {
    changed = false;
    for (const u of all) {
      for (const c of u.calls) {
        const needs = needsOfCall(c);
        if (!needs || covered(c, u.file, needs)) continue;
        if (!D.has(u)) { D.add(u); changed = true; }
        for (const m of needs) if (!u.needs.has(m)) { u.needs.add(m); changed = true; }
      }
    }
  }
  const isDangerous = (c: Call) => needsOfCall(c) !== null;
  const uncovered = (u: Unit) => u.calls.filter((c) => { const n = needsOfCall(c); return n !== null && !covered(c, u.file, n); });

  // ── routes ────────────────────────────────────────────────────────────────────────────────────
  const calledInFile = new Set<Unit>();
  for (const u of all) for (const c of u.calls) if (c.target && c.target.file === u.file && c.target !== u) calledInFile.add(c.target);
  const routes = routeSet;
  const bad: BadRoute[] = [];
  const dangerousRoutes = new Set<string>();
  for (const u of all) {
    if (routes.has(u.file) && u.calls.some(isDangerous)) dangerousRoutes.add(u.file);
    if (!D.has(u) || !routes.has(u.file) || calledInFile.has(u)) continue;
    const at = (c: Call) => `${rel(c.node.getSourceFile().fileName)}:${c.node.getSourceFile().getLineAndCharacterOfPosition(c.node.getStart()).line + 1}`;
    bad.push({ file: u.file, unit: u.name, sites: uncovered(u).map((c) => `${c.callee}[${[...(needsOfCall(c) ?? [])].join('+')}]@${at(c)}`) });
  }
  // Markers: used while the exempted call would otherwise be uncovered; any other marker in a route file is stale.
  const used = new Set<string>();
  for (const u of all) for (const c of u.calls) {
    const needs = needsOfCall(c);
    if (c.exempt && needs && !rawCovered(c, u.file, needs)) used.add(`${u.file}:${c.exempt.line}`);
  }
  if (cfg.flagPrimitiveRoots) {
    // Covered only where a gate DOMINATES it (or the route is wrapped), or a marker sits above its own statement; any gate (SQL is '*').
    for (const u of all) {
      if (!routes.has(u.file) || calledInFile.has(u) || wrapped.has(u.file)) continue;
      const sites: string[] = [];
      for (const site of u.primSites) {
        const g = dominating(site, u.node);
        if (g.size > 0) continue;
        const marker = markersAbove(site).find((m) => m.callee === 'sql');
        if (marker) used.add(`${u.file}:${marker.line}`);
        else sites.push(`sql(primitive)@${u.file}:${site.getSourceFile().getLineAndCharacterOfPosition(site.getStart()).line + 1}`);
      }
      if (sites.length > 0) bad.push({ file: u.file, unit: u.name, sites });
    }
  }
  const staleMarkers: string[] = [];
  for (const f of cfg.routeFiles) {
    const sf = program.getSourceFile(virtual ? f : resolve(ROOT, f));
    if (!sf) continue;
    for (const m of markersIn(sf)) if (!used.has(`${f}:${m.line}`)) staleMarkers.push(`${f}:${m.line} census-exempt(${m.callee})`);
  }
  const why: Record<string, string[]> = {};
  for (const u of D) why[u.key] = uncovered(u).map((c) => `${c.callee}${c.target ? ` -> ${c.target.key}` : ' (primitive)'} needs ${[...(needsOfCall(c) ?? [])].join('+')}`);
  return { bad, dangerousRoutes: [...dangerousRoutes].sort(), why, markersUsed: [...used].sort(), staleMarkers: staleMarkers.sort() };
}
