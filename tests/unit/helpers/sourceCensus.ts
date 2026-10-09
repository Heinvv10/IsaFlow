/**
 * Shared walker and comment stripper for the census-by-table tests (R-035
 * N1b). A census reads the source tree ON DISK — untracked files included —
 * and judges statement TEXT, so two things decide whether it can be trusted:
 *
 *  - what it reads: every file under the roots with a claimed extension, plus
 *    the repository's own top-level code files (middleware.ts and friends).
 *    Tests are left out on purpose: fixtures write as the owner.
 *  - what it strips: comments only. A `//`, `/*` or `--` INSIDE a string or
 *    template literal is text, not a comment — stripping there would hide the
 *    statement after it (adversarial review of PR #689, E3/E5). Inside a
 *    template literal nothing is stripped at all, so an SQL comment that names
 *    a write fails the census loudly rather than hiding one silently.
 *
 * LIMIT (named, not chased): a table name or statement assembled at run time
 * (`'audit_' + 'log'`, a template-built name) is invisible to any text check.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../../..');
export const ROOTS = ['src', 'pages', 'scripts', 'lib', 'chrome-extension', 'config'];
export const SOURCE = /\.(ts|tsx|js|mjs|cjs|sql|sh|py)$/;

function walk(dir: string, out: string[], recurse: boolean): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) walk(full, out, true);
    } else if (SOURCE.test(entry.name)) out.push(full);
  }
}

export interface SourceFile { file: string; text: string }

/** Every census-scope file on disk, repo-relative. */
export function sourceFiles(): SourceFile[] {
  const files: string[] = [];
  walk(ROOT, files, false);
  for (const root of ROOTS) walk(path.join(ROOT, root), files, true);
  return files.map((f) => ({ file: path.relative(ROOT, f), text: readFileSync(f, 'utf8') }));
}

/** JS/TS comments out, strings and template literals kept whole. */
function stripScript(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** SQL comments out (`--`, block), single-quoted literals kept whole. */
function stripSql(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Comments out, by the file's language; shell and Python are judged raw (a comment there fails loudly). */
export function stripComments(text: string, file = 'x.ts'): string {
  if (file.endsWith('.sql')) return stripSql(text);
  if (/\.(sh|py)$/.test(file)) return text;
  return stripScript(text);
}

/** Three-digit migration number; `880b_x.sql` is 880. */
export const migrationNumber = (file: string): number => Number(/(\d{3})[a-z]?_/.exec(path.basename(file))?.[1] ?? 'NaN');
