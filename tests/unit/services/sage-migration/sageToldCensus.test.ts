/**
 * Rounds 36-37 (B36-1, R36-1, R36-3, R37-4): every read of a thrown value the code does not own goes through sageTold.ts (told, codeOf,
 * snapshot / safeThrown / asError) or, in src/lib/rollbackFailed.ts, its own readable(). A census of every .ts file under
 * src/modules/accounting/services/sage-migration and scripts/sage-migration (recursively), and src/lib/rollbackFailed.ts, read from disk
 * (a new untracked file is counted too), with comments removed by a small tokenizer (a `//` inside a string is code):
 *   - the thrown names: a fixed list, plus every name a file binds in `catch (x)`, `.catch((x) =>`, `.then(..., (x) =>` and `on('error', (x) =>`;
 *   - refused, of such a name: String(...) in any spelling, a .message / .code / .errno / .severity / .cause / .stack / .name / .toString read
 *     (also through a cast, a `?.`, spaces), destructuring, bracket access, JSON.stringify, Reflect.get, Object.prototype.toString.call,
 *     string concatenation, a template literal of it;
 *   - the allowlist names our own typed errors, each by its exact code line, with why; an entry that matches nothing fails too.
 * Named limits (round 37): an alias (`const ex = err; ex.message`), a read split across lines, util.inspect. With every foreign value
 * snapshotted where it enters (part 2), the census guards the boundary; it is not the only defence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const DIRS = ['src/modules/accounting/services/sage-migration', 'scripts/sage-migration'];
const FILES = ['src/lib/rollbackFailed.ts'];
const FIXED = ['err', 'e', 'error', 'reason', 'cause', 'raw', 'lost', 'failure', 'waited', 'lookupFailure', 'unlockFailure', 'rollback'];
/** Where a census is allowed to read a thrown value bare: the readers themselves. */
const READERS = new Set(['src/modules/accounting/services/sage-migration/sageTold.ts']);
/** [file, the exact code line (trimmed, comment-free), why it is safe]. */
const ALLOW: Array<[string, string, string]> = [
  ['scripts/sage-migration/runMain.ts', 'say(`${err instanceof RefusedStart ? err.message : stopMessage(err)}${notCreated()}`);', 'RefusedStart: ours (OwnError), its message a string we built; err is a snapshot'],
  ['src/modules/accounting/services/sage-migration/sagePurchaseOrderParser.ts', 'why.push(`no VAT rate can be read for the PO date ${date}: ${err.message}`);', 'VatRateDateError, checked by instanceof on the line before'],
  ['src/modules/accounting/services/sage-migration/sageMigrationRunner.ts', "[waited, b] = [err, { entity: s.entity, n: s.n, size: s.size, key: keyFor(s, before, true), status: 'failed', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, error: err.message }];", 'BatchKeyHeldError | LockWaitError | StatementTimeoutError: ours, checked just before'],
  ['src/modules/accounting/services/sage-migration/sageMigrationRunner.ts', "if (waited !== null) b = { ...b, status: 'failed', error: waited.message };", 'waited: the error above, or session.stall() (ours: LockWaitError | StatementTimeoutError)'],
];

/** Comments replaced by spaces (newlines kept): strings, template literals and their ${...} are tracked, so a `//` in a string stays code. */
export function stripComments(src: string): string {
  let out = '';
  const stack: Array<'tpl' | 'expr'> = [];
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    const inTpl = stack.at(-1) === 'tpl';
    if (quote) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === quote) quote = null; i++; continue; }
    if (inTpl) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '`') stack.pop(); else if (c === '$' && n === '{') { out += '{'; stack.push('expr'); i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; i++; continue; }
    if (c === '`') { stack.push('tpl'); out += c; i++; continue; }
    if (c === '{' && stack.at(-1) === 'expr') stack.push('expr');
    if (c === '}' && stack.at(-1) === 'expr') { stack.pop(); }
    out += c; i++;
  }
  return out;
}

const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => {
  const p = join(dir, f);
  return statSync(join(ROOT, p)).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
});
const files = [...DIRS.flatMap(walk), ...FILES];

/** The thrown names of a file: the fixed list and what it binds from a catch, a rejection handler or an 'error' listener. */
export function thrownNames(code: string): string[] {
  const names = new Set(FIXED);
  for (const re of [/\bcatch\s*\(\s*(\w+)/g, /\.catch\(\s*\(?\s*(\w+)/g, /\bon\(\s*'error'\s*,\s*\(?\s*(\w+)/g, /\.then\([^,()]*(?:\([^)]*\)[^,()]*)*,\s*\(?\s*(\w+)\s*(?::\s*\w+)?\)?\s*=>/g]) {
    for (const m of code.matchAll(re)) if (m[1] && !/^(?:async|function)$/.test(m[1])) names.add(m[1]);
  }
  return [...names];
}

/** What a line does with a thrown name that is refused (round 37's forms), or null. */
export function refused(line: string, names: string[]): string | null {
  const T = `(?:${names.join('|')})`;
  const props = '(?:message|code|errno|severity|cause|stack|name|toString|detail)';
  const forms: Array<[string, RegExp]> = [
    ['String() of it', new RegExp(`\\bString\\(\\s*\\(*\\s*${T}\\b`)],
    ['a property read of it', new RegExp(`\\b${T}\\s*\\??\\s*\\.\\s*${props}\\b`)],
    ['a property read through a cast', new RegExp(`\\(\\s*${T}\\s+as\\s+[^)]*\\)\\s*\\??\\s*\\.\\s*${props}\\b`)],
    ['destructuring it', new RegExp(`\\}\\s*=\\s*\\(?\\s*${T}\\b(?!\\s*=)`)],
    ['bracket access of it', new RegExp(`\\b${T}\\s*\\??\\.?\\[\\s*['"\`]`)],
    ['JSON.stringify of it', new RegExp(`JSON\\.stringify\\(\\s*${T}\\b`)],
    ['Reflect.get of it', new RegExp(`Reflect\\.get\\(\\s*\\(?\\s*${T}\\b`)],
    ['Object.prototype.toString of it', new RegExp(`toString\\.call\\(\\s*${T}\\b`)],
    ['string concatenation of it', new RegExp(`\\b${T}\\s*\\+\\s*['"\`]|['"\`]\\s*\\+\\s*${T}\\b`)],
    ['a template literal of it', new RegExp(`\\$\\{\\s*${T}\\s*\\}`)],
  ];
  for (const [what, re] of forms) if (re.test(line)) return what;
  return null;
}

describe('rounds 36-37: every thrown value the code does not own is read through its reader', () => {
  it('the census covers both trees, recursively, and rollbackFailed', () => {
    expect(files.filter((f) => f.startsWith('src/modules')).length).toBeGreaterThan(30);
    expect(files.filter((f) => f.startsWith('scripts')).length).toBeGreaterThanOrEqual(8);
    expect(files).toContain('src/lib/rollbackFailed.ts');
  });
  it('no refused read of a thrown value outside the readers and the allowlist; no stale allowlist entry', () => {
    const hits: string[] = [];
    const used = new Set<number>();
    for (const f of files) {
      if (READERS.has(f)) continue;
      const code = stripComments(readFileSync(join(ROOT, f), 'utf8'));
      const names = thrownNames(code);
      code.split('\n').forEach((line, i) => {
        const what = refused(line, names);
        if (what === null) return;
        const allowed = ALLOW.findIndex(([file, exact]) => file === f && line.trim() === exact);
        if (allowed >= 0) { used.add(allowed); return; }
        hits.push(`${relative(ROOT, join(ROOT, f))}:${i + 1}: ${what}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
    expect(ALLOW.filter((_, i) => !used.has(i)).map(([file, exact]) => `${file}: ${exact}`)).toEqual([]);
  });
});

describe('the census itself (R37-4): its forms and its comment stripping', () => {
  const names = thrownNames('} catch (problem) {');
  const caught = [
    "log.warn('x', { message: err.message });", 'const m = String(err);', 'const m = err?.message;', 'const { message } = err as Error;',
    'const { message: m } = err as Error;', 'const m = (err as Error).message;', 'const m = (err as { message?: string }).message;',
    "const m = Reflect.get(err as object, 'message');", "const m = err['message'];", "const m = err?.['message'];", 'const m = JSON.stringify(err);',
    'const m = `${String(err)}`;', "const m = '' + err;", "const m = err + '';", 'const m = `failed: ${err.toString()}`;', 'const m = err.toString();',
    'const m = err.stack;', 'const m = err.name;', 'const m = (err as NodeJS.ErrnoException).errno;', 'const m = (err as { severity?: string }).severity;',
    'const m = (err as { cause?: unknown }).cause;', "log.warn('x', { message: problem.message });", "const m = String(err ?? 'unknown');",
    'const m = String(err as Error);', 'const m = String((err));', 'const m = String( err );', 'const m = err .message;',
    'const m = Object.prototype.toString.call(err);', 'const m = String(reason as unknown);', "const m = err instanceof Error ? err.message : 'x';",
    'throw new Error(`lost: ${err}`);',
  ];
  for (const line of caught) it(`refuses: ${line}`, () => { expect(refused(line, names)).not.toBeNull(); });
  it('a `//` inside a string is code; a comment is not; a `*` at a line start is code', () => {
    expect(stripComments("const u = 'http://x'; const m = String(err);").includes('String(err)')).toBe(true);
    expect(stripComments('const n = 1; // String(err)').includes('String(err)')).toBe(false);
    expect(stripComments('/* String(err) */ const n = 2;').includes('String(err)')).toBe(false);
    expect(stripComments('const n = a\n  * String(err).length;').includes('String(err)')).toBe(true);
    expect(stripComments('const t = `a ${b /* c */} // d ${String(err)}`;').includes('String(err)')).toBe(true);
  });
});
