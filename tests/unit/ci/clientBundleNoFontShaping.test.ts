/**
 * NOTHING THE BROWSER BUNDLE REACHES SHAPES TEXT FROM FONT FILES. The pack's figure fit runs on the server
 * (`packFigureFitStamp`) because it reads the woff2 files with fontkit and node:fs (`packGlyphRuler`); the page that
 * prints a pack only renders the size the server decided. This follows every static and dynamic import (not `import
 * type`) from every component and every page outside pages/api, and fails if one reaches packGlyphRuler, fontkit or
 * node:fs. (`next build` fails on node:fs too; this names the chain, and catches fontkit, which would bundle.) A page
 * with getStaticProps, getStaticPaths or getServerSideProps may read files there (Next keeps that code off the
 * client): node:fs is allowed below such a page; packGlyphRuler and fontkit never are.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const FORBIDDEN = /^(?:fontkit|node:fs|fs)$/;
const RULER = path.join(ROOT, 'src/modules/accounting/services/packs/pages/packGlyphRuler.ts');

function files(dir: string, skip: (p: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (skip(p)) return [];
    return statSync(p).isDirectory() ? files(p, skip) : /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The value imports of a file: `import x from`, `export ... from`, `import('...')`; never `import type`. */
function imports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

/** Every chain from `entries` to a module `forbid` names (or to packGlyphRuler), following value imports. */
function chains(entries: readonly string[], forbid: (spec: string) => boolean): string[] {
  const via = new Map<string, string>(entries.map((e) => [e, '']));
  const chain = (f: string): string => { const parts: string[] = []; for (let at: string | undefined = f; at; at = via.get(at) || undefined) parts.unshift(path.relative(ROOT, at)); return parts.join(' -> '); };
  const queue = [...entries];
  const reached: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file === RULER) { reached.push(chain(file)); continue; }
    for (const spec of imports(readFileSync(file, 'utf8'))) {
      if (forbid(spec)) { reached.push(`${chain(file)} -> ${spec}`); continue; }
      const next = resolve(file, spec);
      if (next !== null && !via.has(next)) { via.set(next, file); queue.push(next); }
    }
  }
  return reached;
}

const dataPage = (f: string): boolean => /\bexport\s+(?:async\s+)?(?:function|const)\s+get(?:StaticProps|StaticPaths|ServerSideProps)\b/.test(readFileSync(f, 'utf8'));

it('no component and no page outside pages/api reaches packGlyphRuler, fontkit or node:fs', () => {
  const pages = files(path.join(ROOT, 'pages'), (p) => p === path.join(ROOT, 'pages/api'));
  const client = [...files(path.join(ROOT, 'src/components'), () => false), ...pages.filter((p) => !dataPage(p))];
  expect(client.length).toBeGreaterThan(100);
  expect(chains(client, (spec) => FORBIDDEN.test(spec)).slice(0, 10)).toEqual([]);
  expect(chains(pages.filter(dataPage), (spec) => spec === 'fontkit').slice(0, 10)).toEqual([]);
});
