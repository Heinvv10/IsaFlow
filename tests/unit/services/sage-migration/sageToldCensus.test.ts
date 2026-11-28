/**
 * Rounds 36-37 (B36-1, R36-1, R36-3, R37-4): every read of a thrown value the code does not own goes through sageTold.ts (told, codeOf,
 * snapshot / safeThrown / asError) or, in src/lib/rollbackFailed.ts, its own readable(). A census of every .ts file under
 * src/modules/accounting/services/sage-migration and scripts/sage-migration (recursively), src/lib/rollbackFailed.ts, and (round 38) the two
 * lib files a tool's raw rejection reaches, src/lib/mcp/registry.ts and src/lib/afterCommit.ts, read from disk
 * (a new untracked file is counted too), with comments removed by a small tokenizer (a `//` inside a string is code):
 *   - the thrown names: a fixed list, plus every name a file binds in `catch (x)`, `.catch((x) =>`, `.then(..., (x) =>` and `on('error', (x) =>`
 *     (round 38: also `async` and `function` handlers, either quote, `once`, `uncaughtException` / `unhandledRejection`);
 *   - refused, of such a name: String(...) in any spelling, a .message / .code / .errno / .severity / .cause / .stack / .name / .toString read
 *     (also through a cast, a `?.`, spaces), destructuring, bracket access, JSON.stringify, Reflect.get, Object.prototype.toString.call,
 *     string concatenation, a template literal of it;
 *   - the allowlist names our own typed errors, each by its exact code line, with why; an entry that matches nothing fails too.
 * Named limits (round 37): an alias (`const ex = err; ex.message`), a read split across lines, util.inspect / util.format. Round 38 (R38-5):
 * whole-object reads (Object.keys / entries / getOwnPropertyDescriptor, spread, Object.assign, structuredClone), prototype reads (instanceof, Object.getPrototypeOf), a thrown value handed
 * to the logger as meta (`log.error('x', { err })`: the logger serializes it), and a regex literal right after `)` or an identifier (read
 * as a division). Round 39 (R39-1) refuses coercing built-ins (Number, parseInt, encodeURIComponent...), .concat / a replacement argument,
 * a loose ==/!= with a primitive (=== never coerces, nor == null), a computed key or index, `${[err]}` and [err].toString(); named limit: a
 * handler bound by name and passed on (`const h = (x) => x.message; p.catch(h)`: x is never learnt as a thrown name). With every foreign
 * value snapshotted where it enters (part 2), the census guards the boundary; it is not the only defence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const DIRS = ['src/modules/accounting/services/sage-migration', 'scripts/sage-migration'];
// registry.ts and afterCommit.ts get the driver's rejection (B38 (c)); thrownValue.ts is the generic reader (R39r-5)
const FILES = ['src/lib/rollbackFailed.ts', 'src/lib/mcp/registry.ts', 'src/lib/afterCommit.ts', 'src/lib/thrownValue.ts'];
const FIXED = ['err', 'e', 'error', 'reason', 'cause', 'raw', 'lost', 'failure', 'waited', 'lookupFailure', 'unlockFailure', 'rollback'];
/** Where a census is allowed to read a thrown value bare: the readers themselves. */
const READERS = new Set(['src/lib/thrownValue.ts', 'src/modules/accounting/services/sage-migration/sageTold.ts']);
/** [file, the exact code line (trimmed, comment-free), why it is safe]. */
const ALLOW: Array<[string, string, string]> = [
  ['scripts/sage-migration/runMain.ts', 'say(`${err instanceof RefusedStart ? err.message : stopMessage(err)}${notCreated()}`);', 'RefusedStart: ours (OwnError), its message a string we built; err is a snapshot'],
  ['src/modules/accounting/services/sage-migration/sagePurchaseOrderParser.ts', 'why.push(`no VAT rate can be read for the PO date ${date}: ${err.message}`);', 'VatRateDateError, checked by instanceof on the line before'],
  ['src/modules/accounting/services/sage-migration/sageMigrationRunner.ts', "[waited, b] = [err, { entity: s.entity, n: s.n, size: s.size, key: keyFor(s, before, true), status: 'failed', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, error: err.message }];", 'BatchKeyHeldError | LockWaitError | StatementTimeoutError: ours, checked just before'],
  ['src/modules/accounting/services/sage-migration/sageMigrationRunner.ts', "if (waited !== null) b = { ...b, status: 'failed', error: waited.message };", 'waited: the error above, or session.stall() (ours: LockWaitError | StatementTimeoutError)'],
  ['src/modules/accounting/services/sage-migration/sageStopMessage.ts', "return (b.rowsAbsent > 0 ? line(b, 'replayed: rows absent, nothing written (use --run-tag for a fresh import)') : line(b, 'answered from a stored answer, nothing written')) + lost;", 'lost: the string built on the line before (a fixed name, not a thrown value here)'],
];

/** Where a `/` starts a regex literal, not a division (R38-5): after an operator, a bracket that opens, or a keyword that takes a value. */
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^}]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await))\s*$/;
/** The end of a regex literal starting at `i` (its `/`): escapes and character classes kept, so a `/` or a quote inside it is not seen. */
const regexEnd = (src: string, i: number): number => {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== '\n') {
    const c = src[j]!;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true; else if (c === ']') inClass = false; else if (c === '/' && !inClass) return j + 1;
    j++;
  }
  return -1; // not a regex after all (no closing `/` on its line): a division
};

/**
 * Comments replaced by spaces (newlines kept): strings, template literals and their ${...} are tracked, so a `//` in a string stays code;
 * regex literals too (R38-5: `/^\/*x/` opens no comment, and `/'/` no string).
 */
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
    if (c === '/' && REGEX_AFTER.test(out.slice(-40))) {
      const end = regexEnd(src, i);
      if (end > 0) { out += src.slice(i, end); i = end; continue; }
    }
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
  const fn = '(?:async\\s+)?(?:function\\s*\\w*\\s*)?\\(?\\s*(\\w+)'; // `(x) =>`, `x =>`, `async (x) =>`, `function (x)`, `function f(x)`
  for (const re of [
    /\bcatch\s*\(\s*(\w+)/g,
    new RegExp(`\\.catch\\(\\s*${fn}`, 'g'),
    new RegExp(`\\b(?:on|once|addListener|prependListener|prependOnceListener)\\(\\s*['"\`](?:error|uncaughtException|unhandledRejection)['"\`]\\s*,\\s*${fn}`, 'g'),
    new RegExp(`\\.then\\([^,()]*(?:\\([^)]*\\)[^,()]*)*,\\s*${fn}\\s*(?::\\s*\\w+)?\\)?\\s*(?:=>|\\{)`, 'g'),
  ]) {
    for (const m of code.matchAll(re)) if (m[1] && !/^(?:async|function)$/.test(m[1])) names.add(m[1]);
  }
  return [...names];
}

/** What a line does with a thrown name that is refused (round 37's forms), or null. */
export function refused(line: string, names: string[]): string | null {
  const T = `(?:${names.join('|')})`;
  const props = '(?:message|code|errno|severity|cause|stack|name|toString|detail|constraint|where|hint|table|column|schema|routine|length)';
  const forms: Array<[string, RegExp]> = [
    ['String() of it', new RegExp(`\\bString\\(\\s*\\(*\\s*${T}\\b`)],
    ['a property read of it', new RegExp(`\\b${T}\\s*!?\\s*\\??\\s*\\.\\s*${props}\\b`)],
    ['a property read through a cast', new RegExp(`\\(+\\s*(?:<[^>]*>\\s*)?${T}\\s*(?:as\\s+[^)]*)?\\)+\\s*!?\\s*\\??\\s*\\.\\s*${props}\\b`)],
    ['destructuring a caught value', /\bcatch\s*\(\s*[{[]/],
    ['a built-in Error made of it', new RegExp(`\\bnew\\s+(?:Type|Range|Syntax|Reference|Eval|URI)?Error\\(\\s*\\(*\\s*${T}\\b(?!\\s*(?:\\?\\.|\\.|\\(|\\[))`)],
    ['an array of it joined', new RegExp(`\\[[^\\]]*\\b${T}\\b[^\\]]*\\]\\s*\\.\\s*(?:join|toString|toLocaleString)\\b`)],
    // R39-1: a built-in that coerces its argument, a loose comparison with a primitive, a computed key, an array in a template
    ['a coercing built-in of it', new RegExp(`(?<![.\\w])(?:Number|parseInt|parseFloat|BigInt|encodeURIComponent|encodeURI|decodeURIComponent|escape|isNaN|isFinite)\\(\\s*\\(*\\s*${T}\\b(?!\\s*(?:\\?\\.|\\.|\\[|\\())`)],
    ['concat or a replacement of it', new RegExp(`\\.concat\\([^)]*\\b${T}\\b|\\.replace(?:All)?\\([^,]*,\\s*\\(*\\s*${T}\\b`)],
    ['a loose comparison of it', new RegExp(`\\b${T}\\s*[!=]=(?!=)\\s*(?![\\s=]|null\\b|undefined\\b)|(?<![!=])[!=]=\\s*\\(*\\s*${T}\\b`)],
    ['a computed key or index of it', new RegExp(`[\\w\\])]\\??\\.?\\[\\s*\\(*\\s*${T}\\b|\\[\\s*${T}\\s*\\]\\s*:`)],
    ['an array of it in a template', new RegExp(`\\$\\{\\s*\\[[^\\]]*\\b${T}\\b`)],
    ['destructuring it', new RegExp(`\\}\\s*=\\s*\\(?\\s*${T}\\b(?!\\s*=)`)],
    ['bracket access of it', new RegExp(`\\b${T}\\s*\\??\\.?\\[\\s*['"\`]`)],
    ['JSON.stringify of it', new RegExp(`JSON\\.stringify\\(\\s*${T}\\b`)],
    ['Reflect.get of it', new RegExp(`Reflect\\.get\\(\\s*\\(?\\s*${T}\\b`)],
    ['Object.prototype.toString of it', new RegExp(`toString\\.call\\(\\s*${T}\\b`)],
    ['string concatenation of it', new RegExp(`\\b${T}\\s*\\)*\\s*\\+(?![+=])|(?:[^+]\\+|\\+=)\\s*\\(*\\s*${T}\\b(?!\\s*(?:\\?\\.|\\.|\\(|\\[))`)],
    ['a template literal of it', new RegExp(`\\$\\{\\s*\\(*\\s*${T}\\s*(?:as\\s+[^}]*)?\\)*\\s*\\}`)],
  ];
  for (const [what, re] of forms) if (re.test(line)) return what;
  return null;
}

describe('rounds 36-37: every thrown value the code does not own is read through its reader', () => {
  it('the census covers both trees, recursively, and rollbackFailed', () => {
    expect(files.filter((f) => f.startsWith('src/modules')).length).toBeGreaterThan(30);
    expect(files.filter((f) => f.startsWith('scripts')).length).toBeGreaterThanOrEqual(8);
    expect(files).toContain('src/lib/rollbackFailed.ts');
    expect(files).toEqual(expect.arrayContaining(['src/lib/mcp/registry.ts', 'src/lib/afterCommit.ts', 'src/lib/thrownValue.ts'])); // B38 (c), R39r-5
    expect([...READERS].every((f) => files.includes(f))).toBe(true); // every reader is a file the census knows (it is skipped as the reader)
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
    // R38-5 / B38 (e)
    'const c = err.constraint;', 'const w = (err as { where?: string }).where;', 'const h = err?.hint;', 'const m = err!.message;',
    'const m = (<Error>err).message;', 'const m = ((err as Error)).message;', 'const m = `${err as unknown}`;', 'const m = `${(err)}`;',
    'throw new Error(err as string);', 'const m = prefix + err;', 'const m = err + suffix;', 'text += err;', "const m = [err].join(' ');",
    '} catch ({ message }) {',
    // R39-1
    'const n = Number(err);', 'const n = parseInt(err, 10);', 'const u = encodeURIComponent(err);', "const s = 'a'.concat(err);",
    "const s = 'x'.replace('y', err);", "if (err == 'x') return;", "if ('x' != err) return;", 'const o = { [err]: 1 };', 'const v = table[err];',
    'const s = `${[err]}`;', 'const s = [err].toString();', 'const n = (err as string).length;',
  ];
  for (const line of caught) it(`refuses: ${line}`, () => { expect(refused(line, names)).not.toBeNull(); });
  const allowed = ['const m = told(err);', 'throw new ConnectionLostError(err, \'no-connection\');', 'const n = items.length + 1;', 'i++;',
    'const err = snapshot(raw);', 'throw new Error(told(err));', 'if (err === noAnswer) return;', 'if (err == null) return;',
    "if (err !== 'x') return;", 'const [a, b] = [err, 1];', 'xs.push(err);', 'if (x) [lost, by] = [err, 1];', 'const ok = Number.isFinite(raw.Total);'];
  for (const line of allowed) it(`lets pass: ${line}`, () => { expect(refused(line, names)).toBeNull(); });
  it('learns the names a file binds (R38-5): async and function handlers, double quotes, once, process events', () => {
    const learnt = thrownNames([
      'p.catch(async (a1) => a1);', 'p.catch(function (a2) { return a2; });', 'p.then(ok, async (a3) => a3);', 'p.then(ok, function (a4) {});',
      'c.on("error", (a5) => a5);', "c.once('error', (a6) => a6);", "process.on('uncaughtException', (a7) => a7);", 'p.catch(a8 => a8);',
    ].join('\n'));
    for (const n of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']) expect(learnt).toContain(n);
  });
  it('a regex literal opens no comment and no string (R38-5)', () => {
    expect(stripComments('const r = /^\\/*x/; const m = String(err); // */').includes('String(err)')).toBe(true);
    expect(stripComments('const r = /^a\\/\\//; const m = String(err);').includes('String(err)')).toBe(true);
    expect(stripComments("const q = /'/; const u = 'http://x'; const m = err.message;").includes('err.message')).toBe(true);
    expect(stripComments('const r = /["/]/.test(s); const m = String(err);').includes('String(err)')).toBe(true);
    expect(stripComments('const h = a / b; // String(err)').includes('String(err)')).toBe(false);
  });
  it('a `//` inside a string is code; a comment is not; a `*` at a line start is code', () => {
    expect(stripComments("const u = 'http://x'; const m = String(err);").includes('String(err)')).toBe(true);
    expect(stripComments('const n = 1; // String(err)').includes('String(err)')).toBe(false);
    expect(stripComments('/* String(err) */ const n = 2;').includes('String(err)')).toBe(false);
    expect(stripComments('const n = a\n  * String(err).length;').includes('String(err)')).toBe(true);
    expect(stripComments('const t = `a ${b /* c */} // d ${String(err)}`;').includes('String(err)')).toBe(true);
  });
});
