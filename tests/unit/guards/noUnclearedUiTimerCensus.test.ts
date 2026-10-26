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

/** The text of the call's argument list, from just after `(` to its balanced `)`. */
function callArgs(src: string, open: number): string {
  let depth = 1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && (depth -= 1) === 0) return src.slice(open, i);
  }
  return src.slice(open);
}

/** Line numbers of `setTimeout(` / `window.setTimeout(` calls whose handle is discarded and whose callback sets state. */
export function findBareStateTimers(source: string): number[] {
  const src = source.replace(/^[ \t]*\/\/.*$/gm, '');
  const hits: number[] = [];
  for (const m of src.matchAll(/(?:\b(?:window|globalThis)\.)?\bsetTimeout\(/g)) {
    const before = src.slice(0, m.index).trimEnd();
    const discarded = before === '' || ';{})>'.includes(before.slice(-1)) || /\belse$/.test(before);
    if (discarded && /\bset[A-Z]\w*\(/.test(callArgs(src, m.index! + m[0].length))) {
      hits.push(src.slice(0, m.index).split('\n').length);
    }
  }
  return hits;
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
    expect(findBareStateTimers("window.setTimeout(() => setCopied(false), 2000);")).toEqual([1]);
    expect(findBareStateTimers("globalThis.setTimeout(() => setCopied(false), 2000);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => { if (open) setOpen(false); }, 150);")).toEqual([1]);
    expect(findBareStateTimers("setTimeout(() => (ok ? setA(1) : setB(2)), 150);")).toEqual([1]);
    expect(findBareStateTimers("x();\n// after a comment.\nsetTimeout(() => { setToast(null); }, 3000);")).toEqual([3]);
  });

  it('leaves a timer whose handle is kept, or whose callback sets no state', () => {
    expect(findBareStateTimers("const t = setTimeout(() => setToast(null), 3500);")).toEqual([]);
    expect(findBareStateTimers("ref.current = setTimeout(() => setOpen(false), 150);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => window.location.reload(), 500);")).toEqual([]);
    expect(findBareStateTimers("const t = window.setTimeout(() => setX(1), 5);")).toEqual([]);
    expect(findBareStateTimers("setTimeout(() => reload(), 5); setX(1);")).toEqual([]);
  });

  it('lists only files that still exist (a stale exemption is a failure)', () => {
    for (const f of PENDING_OWNER) expect(findBareStateTimers(readFileSync(`${ROOT}/${f}`, 'utf8')).length).toBeGreaterThan(0);
  });
});
