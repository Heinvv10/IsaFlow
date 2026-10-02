/**
 * clientResponseRule — a REGRESSION GUARD for how client code reads an API response. It is not a proof of
 * completeness: it catches the common shapes of the defects that kept coming back, and says which it does not.
 *
 * `apiFetch` RESOLVES on 4xx/5xx, so every consumer must look at the HTTP status before it trusts the body, say
 * what failed in a plain sentence, never show raw error text, and check every write. Matched with the TYPE
 * CHECKER and symbols where a type decides it (a Response-typed value, an import alias of an apiFetch helper),
 * and by syntax where only syntax can (messages, busy flags):
 *
 *   a  a body read on a Response-typed value with no dominating status check          (clientResponseFlow.ts)
 *   b  a bare / status-code message reaching a person ("Failed", "Something went wrong - try again", `HTTP ${s}`,
 *      the same words as a JSX message attribute); the assertOk / apiJson / apiErrorMessage fallback ARGUMENT
 *      (it is what a 502 or an empty 500 shows) must say what failed; apiJson with no sentence (clientResponseMessages.ts)
 *   c  raw error text (err.message, String(err), a template, a destructured message) from a catch, .catch,
 *      .then(_, h), onError, a named / useCallback handler, a local function the error is passed to, or a
 *      useState setter given to .catch, when it reaches a person                   (clientResponseMessages.ts)
 *   d  a write (method not provably GET) whose result is never checked; other transports (clientResponseFlow.ts)
 *   e  a busy flag set true with no `finally` (or catch, when the page navigates away) that clears it; and the
 *      converse: `finally { setBusy(false) }` after a navigation that is not awaited   (clientResponseLoads.ts)
 *   f  a failed load that shows an error but keeps the rows it failed to refresh       (clientResponseLoads.ts)
 *   g  `if (!res.ok) return;` / `|| !res.ok` / `status !== 200` / `return []`, or `if (res.ok) {...}` last: a failure
 *      dropped in silence                                                           (clientResponseLoads.ts)
 *
 * STATED LIMITS, one line per group (the fixture named is the example; every one is in
 * tests/unit/ci/clientResponseFixtures*.ts and asserted to still be missed, so a fix flips it on purpose):
 *   - a value typed any/unknown is not a Response (`as any`, an undeclared name, a value derived from a body)   [A9, a03]
 *   - ONE status code tested for equality (404, 204, 401) counts as the status check                  [a01, a04, a09, d07, d08]
 *   - a status copied to a const and judged after the read                                                   [a02]
 *   - a message built from several parts, a lookup table, an assignment or in another module                 [b05, b07-b09]
 *   - a caught error stored in a reducer / class state / a settled `reason` / an array, or turned into text
 *     by a helper in another file                                                                    [c02-c06, c10]
 *   - a write whose result is returned from a hook or a wrapper in another module, reduced to a boolean the
 *     caller ignores, or checked on one branch only                                              [d02-d05, d09]
 *   - busy flags outside an async function with a setX(true) call (.then chains, class state, a try after the
 *     await); loads through apiJson, a destructured body or .then(setRows)                      [e02-e05, f01-f03]
 *   - a `return res.ok` hands the status to the caller and counts as a check; a helper in ANOTHER file that
 *     reads a body is scanned only when a client imports it and it touches a Response or the network
 *   - tests, scripts, pages/api and code in a function named getServerSideProps / getStaticProps are not client
 *     code; a pin (client-responses.pins.json) is the only accepted exception and carries a reason.
 * The CLI (check-client-responses.ts) selects client files by imports (clientResponseSelect.ts), applies pins,
 * and fails closed (no files, a parse error, a stale or reasonless pin).
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { analyzeFlow } from './clientResponseFlow';
import { analyzeLoads } from './clientResponseLoads';
import { analyzeMessages } from './clientResponseMessages';
import { type Add, type Ctx, type Hit, inServerOnlyFn, makeCanon } from './clientResponseShared';

export type { Hit, HitKind } from './clientResponseShared';
export interface Analysis { hits: Hit[]; parseErrors: string[] }

const SHIM = '/virtual/@lib/apiFetch.d.ts';
const SHIM_TEXT = `export declare function apiFetch(url: string, options?: RequestInit): Promise<Response>;
export declare function assertOk(res: Response, fallback: string): Promise<void>;
export declare function apiJson(url: string, options?: RequestInit, failureMessage?: string): Promise<any>;
export declare function apiErrorMessage(err: unknown, fallback: string): string;
export declare class ApiRequestError extends Error { status: number }
export declare class ApiEnvelopeError extends Error {}
`;
const libCache = new Map<string, ts.SourceFile>();

function runChecks(program: ts.Program, files: string[], display: (f: string) => string): Analysis {
  const checker = program.getTypeChecker();
  const hits: Hit[] = []; const parseErrors: string[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) { parseErrors.push(`${display(file)}: not part of the program`); continue; }
    if (program.getSyntacticDiagnostics(sf).length) parseErrors.push(`${display(file)}: syntax errors (the gate would judge a degenerate tree)`);
    const lines = sf.text.split('\n');
    const add: Add = (n, kind, reason) => {
      if (inServerOnlyFn(n)) return;   // getServerSideProps and friends run on the server; the rest of the page is client code
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
      hits.push({ file: display(file), line: line + 1, kind, reason, lineText: (lines[line] ?? '').trim() });
    };
    let byText: Map<string, ts.Identifier[]> | undefined;
    const idsByText = () => {
      if (byText) return byText;
      byText = new Map();
      const walk = (n: ts.Node) => { if (ts.isIdentifier(n)) { const l = byText!.get(n.text); if (l) l.push(n); else byText!.set(n.text, [n]); } ts.forEachChild(n, walk); };
      walk(sf);
      return byText;
    };
    const cx: Ctx = {
      checker, sf, add, canon: makeCanon(sf),
      sym: (n) => checker.getSymbolAtLocation(n),
      refs: (s) => (idsByText().get(s.name) ?? []).filter((id) => checker.getSymbolAtLocation(id) === s),
    };
    analyzeFlow(cx); analyzeMessages(cx); analyzeLoads(sf, add);
  }
  const seen = new Set<string>();
  return { parseErrors, hits: hits.filter((h) => { const k = `${h.file}:${h.line}:${h.kind}:${h.reason}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

/** Real files, with the repo's own tsconfig (paths, JSX) so imports resolve and types are the real ones. */
export function analyzePaths(paths: string[]): Analysis {
  const cfg = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, process.cwd());
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined, skipLibCheck: true, types: [], plugins: undefined, allowJs: true };
  const abs = paths.map((p) => ts.sys.resolvePath(p));
  const program = ts.createProgram(abs, options);
  return runChecks(program, abs, (f) => f.replace(`${ts.sys.resolvePath('.')}/`, ''));
}

/** In-memory sources (the unit-test fixtures): `@/lib/apiFetch` resolves to a declaration shim, nothing else resolves. */
export function analyzeSources(sources: Array<{ file: string; text: string }>): Analysis {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2020, lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'], strict: true, jsx: ts.JsxEmit.Preserve, noEmit: true, skipLibCheck: true, types: [], allowJs: true, noResolve: false };
  const mem = new Map(sources.map((s) => [`/virtual/${s.file}`, s.text] as const)); mem.set(SHIM, SHIM_TEXT);
  const base = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => mem.has(f) || base.fileExists(f),
    readFile: (f) => mem.get(f) ?? base.readFile(f),
    getSourceFile: (f, lv, onErr) => {
      if (mem.has(f)) return ts.createSourceFile(f, mem.get(f)!, lv, true);
      const hit = libCache.get(f); if (hit) return hit;
      const sf = base.getSourceFile(f, lv, onErr); if (sf) libCache.set(f, sf);
      return sf;
    },
    resolveModuleNames: (names, containing) => names.map((n) => {
      if (n === '@/lib/apiFetch') return { resolvedFileName: SHIM, extension: ts.Extension.Dts };
      // another source of the same fixture: `@/lib/x` or `./x`
      const dir = containing.replace(/\/[^/]*$/, '');
      const target = n.startsWith('@/') ? `/virtual/src/${n.slice(2)}` : n.startsWith('.') ? `${dir}/${n}`.replace(/\/\.\//g, '/') : undefined;
      const hit = target && ['.ts', '.tsx', '.js', '.jsx'].map((e) => target + e).find((c) => mem.has(c));
      if (hit) return { resolvedFileName: hit, extension: hit.endsWith('x') ? ts.Extension.Tsx : ts.Extension.Ts };
      // a package the fixtures import (react, react-hot-toast): the repo's own typings, so the types are the real ones
      if (!n.startsWith('.') && !n.startsWith('@/')) return ts.resolveModuleName(n, `${process.cwd()}/zz.tsx`, options, base).resolvedModule;
      return undefined;
    }),
  };
  const roots = sources.map((s) => `/virtual/${s.file}`);
  const program = ts.createProgram([...roots, SHIM], options, host);
  return runChecks(program, roots, (f) => f.replace('/virtual/', ''));
}

export function analyzeFile(file: string, text: string): Hit[] { return analyzeSources([{ file, text }]).hits; }
export const readText = (f: string) => readFileSync(f, 'utf8');
