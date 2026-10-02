/**
 * clientResponseRule — the census gate for how client code reads an API response.
 *
 * `apiFetch` RESOLVES on 4xx/5xx, so every consumer must look at the status before it trusts the body, say
 * what failed in a plain sentence, never show raw error text, and check every write. Defect classes that kept
 * coming back one review round at a time (D2, 2026-10), found here by the TYPE CHECKER and SYMBOLS rather than
 * by text, so a natural variation of a shape cannot slip past:
 *
 *   a  a body read on a value typed Response with no dominating status check          (clientResponseFlow.ts)
 *   b  a bare / status-code message reaching a person; apiJson with no sentence        (clientResponseMessages.ts)
 *   c  raw error text from a catch / .catch / .then(_, h) / onError handler            (clientResponseMessages.ts)
 *   d  a write (method not provably GET) whose result is never checked; other transports (clientResponseFlow.ts)
 *   e  a busy flag set true with no `finally` that clears it                           (clientResponseLoads.ts)
 *   f  a failed load that shows an error but keeps the rows it failed to refresh       (clientResponseLoads.ts)
 *   g  `if (!res.ok) return;` / `if (res.ok) {...}` last: a failure dropped in silence (clientResponseLoads.ts)
 *
 * STATED LIMITS (each is a place a determined author can still hide, so review stays necessary):
 *   - a value typed `any` / `unknown` is not a Response to the checker (an `as any` cast, an untyped JS import);
 *   - a response handed to a helper declared in ANOTHER file is not followed (the helper's own file is scanned,
 *     and a callee parameter that reads a body unchecked is a hit there); a local helper's first parameter is
 *     followed one level for checks;
 *   - a status check counts when it DOMINATES the read by position (an enclosing block, or an if/?:/&& scope),
 *     it is not proved to exit early: `if (!res.ok) { log(); }` followed by a read counts as a check;
 *   - class d follows a returned write through LOCAL named functions and .map callbacks only, and a wrapper that
 *     returns the write from another module is not followed;
 *   - class b/c judge text by shape: a message built from several parts, or fetched from a table, is not seen;
 *   - e/f/g are syntactic (a flag cleared by a caller or .finally(); one-shot loads that the gate cannot tell
 *     from rows) and f asks for the reset everywhere on purpose.
 * The CLI (check-client-responses.ts) selects client files by CONTENT, applies pins, and fails closed.
 * tests/unit/ci/clientResponseRule*.test.ts hold the mutation fixtures.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { analyzeFlow } from './clientResponseFlow';
import { analyzeLoads } from './clientResponseLoads';
import { analyzeMessages } from './clientResponseMessages';
import type { Add, Ctx, Hit } from './clientResponseShared';

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
      checker, sf, add,
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
    resolveModuleNames: (names) => names.map((n) => (n === '@/lib/apiFetch' ? { resolvedFileName: SHIM, extension: ts.Extension.Dts } : undefined)),
  };
  const roots = sources.map((s) => `/virtual/${s.file}`);
  const program = ts.createProgram([...roots, SHIM], options, host);
  return runChecks(program, roots, (f) => f.replace('/virtual/', ''));
}

export function analyzeFile(file: string, text: string): Hit[] { return analyzeSources([{ file, text }]).hits; }
export const readText = (f: string) => readFileSync(f, 'utf8');
