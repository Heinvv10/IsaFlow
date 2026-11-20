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

const MARKER = /census-exempt\(([A-Za-z0-9_-]+)\):\s*(\S[^\n*]*)/g;

/** Every `census-exempt(<callee>): reason` marker in a source file, with its line. */
export function markersIn(sf: ts.SourceFile): Array<{ callee: string; line: number }> {
  const out: Array<{ callee: string; line: number }> = [];
  for (const m of sf.text.matchAll(MARKER)) out.push({ callee: m[1]!, line: sf.getLineAndCharacterOfPosition(m.index!).line + 1 });
  return out;
}

/** The markers in the comments directly above the statement holding `node` (callee and line). */
export function markersAbove(node: ts.Node): Array<{ callee: string; line: number }> {
  let stmt: ts.Node = node;
  while (stmt.parent && !ts.isStatement(stmt)) stmt = stmt.parent;
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, stmt.getFullStart()) ?? [];
  return ranges.flatMap((r) => [...sf.text.slice(r.pos, r.end).matchAll(MARKER)]
    .map((m) => ({ callee: m[1]!, line: sf.getLineAndCharacterOfPosition(r.pos + m.index!).line + 1 })));
}
