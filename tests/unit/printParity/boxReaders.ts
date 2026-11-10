/**
 * EVERY SOURCE FILE THAT READS THE MEASURED CONTENT BOX, through any path: `packTextMetrics.ts` exports it, a module that
 * re-exports one of its names (as itself or under an alias, or `export *`) exposes it too, and a file that imports one of
 * those names (or the whole module) from any module exposing it reads it. Tracked files and untracked ones that git
 * does not ignore, so a new file is counted before it is committed. `paritySkip.test.ts` holds every reader to
 * `PARITY_PATHS`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const BOX_NAMES = ['PAGE_WIDTH_MM', 'PAGE_BOX_MM', 'CONTAINER_WIDTH_MM', 'PRINT_CONTENT_PX', 'PRINT_CONTAINER_PX', 'PRINT_CONTENT_HEIGHT_PX'] as const;
const SOURCE = 'src/modules/accounting/services/packs/pages/packTextMetrics.ts';

/** `spec` imported from `from`, as a repository-relative file, or null where it is a package. */
export function resolveImport(root: string, from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(root, path.dirname(from), spec) : null;
  if (base === null) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return path.relative(root, c);
  }
  return null;
}

interface Edge { kind: 'import' | 'export'; spec: string; names: Array<{ name: string; as: string }>; all: boolean }

/** A file's import and export-from statements: the names each takes, renamed or not, or all of them. */
export function edges(source: string): Edge[] {
  const out: Edge[] = [];
  for (const m of source.matchAll(/\b(import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[2]!;
    const braced = /\{([^}]*)\}/.exec(clause);
    const names = braced === null ? [] : braced[1]!.split(',').map((p) => p.trim()).filter((p) => p !== '' && !p.startsWith('type '))
      .map((p) => { const [name, as] = p.split(/\s+as\s+/); return { name: name!.trim(), as: (as ?? name!).trim() }; });
    out.push({ kind: m[1] as 'import' | 'export', spec: m[3]!, names, all: /\*/.test(clause.replace(/\{[^}]*\}/, '')) });
  }
  return out;
}

/** The files that read the box, in `files` (repository-relative), with every module that exposes it and under which names. */
export function boxReaders(root: string, files: readonly string[], read: (file: string) => string = (f) => readFileSync(path.join(root, f), 'utf8')): string[] {
  const exposed = new Map<string, Set<string>>([[SOURCE, new Set(BOX_NAMES)]]);
  const parsed = new Map(files.map((f) => [f, edges(read(f)).map((e) => ({ ...e, target: resolveImport(root, f, e.spec) }))]));
  for (let grew = true; grew;) {
    grew = false;
    for (const [file, list] of parsed) {
      for (const e of list) {
        const names = e.target === null ? undefined : exposed.get(e.target);
        if (e.kind !== 'export' || names === undefined) continue;
        const passed = e.all ? [...names] : e.names.filter((n) => names.has(n.name)).map((n) => n.as);
        const mine = exposed.get(file) ?? new Set<string>();
        for (const n of passed) if (!mine.has(n)) { mine.add(n); grew = true; }
        if (mine.size > 0) exposed.set(file, mine);
      }
    }
  }
  return [...parsed].filter(([file, list]) => file === SOURCE || list.some((e) => {
    const names = e.target === null ? undefined : exposed.get(e.target);
    return names !== undefined && (e.all || e.names.some((n) => names.has(n.name)));
  })).map(([file]) => file).sort();
}

/** The source files git tracks or would add (untracked and not ignored). */
export function sourceFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx?$/.test(f) && existsSync(path.join(root, f)));
}
