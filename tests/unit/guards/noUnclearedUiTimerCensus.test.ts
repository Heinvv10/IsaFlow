/**
 * A UI timer that resets state ("Copied!", an auto-dismissed toast) must not be a bare `setTimeout(() => setX(...))`:
 * nothing cancels it, so it fires into an unmounted page (a state update on a dead component, or into a torn-down test
 * environment). Use `useTimeoutOnce()` from '@/hooks/useTimeoutOnce', which replaces a pending timer and cancels on unmount.
 *
 * A timer whose handle is kept (`const t = setTimeout(...)`, `ref.current = setTimeout(...)`) is cleared by its owner and
 * is not flagged. Reads the working tree (tracked and untracked files), so a new file cannot slip past before it is added.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const ROOT = process.cwd();

/** Owned by another in-flight PR; remove each entry when its owner converts the timer. */
const PENDING_OWNER: readonly string[] = [
  'src/components/layout/AppLayout.tsx', // PWA install banner: shell PR (S)
];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'pages'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => /\.tsx?$/.test(f) && !PENDING_OWNER.includes(f));

/**
 * The text of the call's argument list, from just after `(` to its balanced `)`, with comments dropped. Quoted and
 * template spans are skipped, so a `)` inside a string does not end the scan early. `'` and `"` spans end at a newline
 * (a JS string cannot span one), so an apostrophe the scan misreads costs one line, not the rest of the file. Regex
 * literals are skipped where an operand can start. A `${...}` inside a template is skipped with the template, which is
 * fine here: a setter call inside
 * one is not a timer callback.
 */
function callArgs(src: string, open: number): string {
  let depth = 1;
  let out = '';
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!;
    const start = i;
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (ch === '/' && /[(,=:{;!&|?]$/.test(out.trimEnd())) {
      // a regex literal (a `/` where an operand starts): skip it, so a quote or paren inside it is not read as code
      for (i += 1; i < src.length && src[i] !== '/' && src[i] !== '\\n'; i += 1) if (src[i] === '\\') i += 1;
      out += src.slice(start, i + 1);
    } else if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < src.length && src[i] !== ch && (ch === '`' || src[i] !== '\n'); i += 1) if (src[i] === '\\') i += 1;
      out += src.slice(start, i + 1);
    } else if (ch === '(') { depth += 1; out += ch; }
    else if (ch === ')' && (depth -= 1) === 0) return out;
    else out += ch;
  }
  return out;
}

/** A state setter call: `setX(`, not a method (`d.setHours(`) and not a nested timer (`setTimeout(`, `setInterval(`). */
const STATE_SETTER = /(?<![.\w])set(?!(?:Timeout|Interval|Immediate)\()[A-Z]\w*\(/;

/** Line numbers of `setTimeout(` / `window.setTimeout(` calls whose handle is discarded and whose callback sets state. */
export function findBareStateTimers(source: string): number[] {
  const src = source.replace(/^[ \t]*\/\/.*$/gm, '');
  const hits: number[] = [];
  for (const m of src.matchAll(/(?:\b(?:window|globalThis)\.)?\bsetTimeout\(/g)) {
    const before = src.slice(0, m.index).trimEnd();
    const discarded = before === '' || ';{})>'.includes(before.slice(-1)) || /\belse$/.test(before);
    if (discarded && STATE_SETTER.test(callArgs(src, m.index! + m[0].length))) {
      hits.push(src.slice(0, m.index).split('\n').length);
    }
  }
  return [...new Set(hits)];
}

describe('no uncleared UI state timers', () => {
  it('has no discarded setTimeout that sets state under src/ or pages/', () => {
    const found = files.flatMap((f) => findBareStateTimers(readFileSync(`${ROOT}/${f}`, 'utf8')).map((l) => `${f}:${l}`));
    expect(found).toEqual([]);
  });

  it('flags the shapes it is meant to flag', () => {
    expect(findBareStateTimers("  setTimeout(() => setCopied(false), 2000);")).toEqual([1]);
    expect(findBareStateTimers("if (ok) setTimeout(() => setMsg(''), 3000);")).toEqual([1]);
    expect(findBareStateTimers("onBlur={() => setTimeout(() => setOpen(false), 150)}")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => { log(')'); setOpen(false); }, 150);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => { log(`)`); setOpen(false); }, 150);")).toEqual([1]);
    expect(findBareStateTimers("window.setTimeout(() => setCopied(false), 2000);")).toEqual([1]);
    expect(findBareStateTimers("globalThis.setTimeout(() => setCopied(false), 2000);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => { if (open) setOpen(false); }, 150);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => { if (/'/.test(a)) setOpen(false); }, 5);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => { // don't\n  setOpen(false);\n}, 5);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => { setTimeout(() => setOpen(false), 1); }, 5);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => (ok ? setA(1) : setB(2)), 150);")).toEqual([1]);
    expect(findBareStateTimers("x();\n// after a comment.\nsetTimeout(() => { setToast(null); }, 3000);")).toEqual([3]);
  });

  it('leaves a timer whose handle is kept, or whose callback sets no state', () => {
    expect(findBareStateTimers("const t = setTimeout(() => setToast(null), 3500);")).toEqual([]);
    expect(findBareStateTimers("ref.current = setTimeout(() => setOpen(false), 150);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => window.location.reload(), 500);")).toEqual([]);
    expect(findBareStateTimers("const t = window.setTimeout(() => setX(1), 5);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => reload(), 5); setX(1);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => { if (/'/.test(a)) reload();\n}, 5);\nconst y = setOpen(1);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => { if (ok) /'/.test(a);\n  reload(); }, 5);\nsetOpen(1); const s = 'x';")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => { // don't\n  reload();\n}, 5);\nconst x = setOpen(1);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => { /* it's ) */ reload(); }, 5);\nsetOpen(1);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => { reload(); // setOpen(false)\n}, 5);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => { setTimeout(() => reload(), 1); }, 5);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => { setInterval(tick, 1); }, 5);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => input.setSelectionRange(0, 0), 0);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => d.setHours(0), 0);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => el.setAttribute('x', '1'), 0);")).toEqual([]);
  });

  it('lists only files that still exist (a stale exemption is a failure)', () => {
    for (const f of PENDING_OWNER) expect(findBareStateTimers(readFileSync(`${ROOT}/${f}`, 'utf8')).length).toBeGreaterThan(0);
  });
});
