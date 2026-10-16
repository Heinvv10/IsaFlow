/**
 * No id is validated with Zod 4's strict `.uuid()` / `z.uuid()`.
 *
 * Zod 4's uuid checks (`.uuid()`, `z.uuid()`, `z.uuidv4()`/`v6`/`v7`, with or
 * without a message argument) enforce the RFC 4122 version nibble, so they refuse the
 * seeded ISAFlow Demo company id 00000000-0000-0000-0000-000000000001 (version
 * 0), which Postgres stores happily. Ids are validated with `UUID` (`z.guid()`)
 * from src/lib/schemas/common.ts, the one place allowed to name `z.uuid` (in
 * its comment). This census reads every .ts/.tsx under pages/ and src/ with
 * comments stripped, and fails on any strict uuid validator.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['pages', 'src'];
const ALLOWED = new Set(['src/lib/schemas/common.ts']);
const STRICT_UUID = /\.\s*uuid(?:v\d+)?\s*\(/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Strip block and line comments (good enough for a census: no regex literals name uuid). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function strictUuidOffenders(sources: Record<string, string>): string[] {
  return Object.entries(sources).flatMap(([path, text]) => {
    const body = code(text);
    return [...body.matchAll(STRICT_UUID)].map((m) => {
      const line = body.slice(0, m.index).split('\n').length;
      return `${path}:${line}: ${body.split('\n')[line - 1]!.trim()}`;
    });
  });
}

describe('census: no strict Zod uuid validator on an id', () => {
  it('pages/ and src/ use UUID (z.guid()) from src/lib/schemas/common.ts, never .uuid()', () => {
    const sources: Record<string, string> = {};
    for (const root of ROOTS) {
      for (const f of files(root)) if (!ALLOWED.has(f)) sources[f] = readFileSync(f, 'utf8');
    }
    expect(Object.keys(sources).length).toBeGreaterThan(500);
    expect(strictUuidOffenders(sources)).toEqual([]);
  });

  it('the detector catches each spelling and ignores comments', () => {
    expect(strictUuidOffenders({
      'a.ts': "const A = z.string().uuid();",
      'b.ts': "const B = z.uuid();",
      'c.ts': "id: z.string().min(1).uuid({ message: 'bad' }),",
      'f.ts': "id: z.string().uuid('bad id'),",
      'g.ts': "id: z\n  .string()\n  .uuid(\n    { message: 'bad' })",
      'h.ts': "bundleId: z.uuidv4(),",
      'd.ts': "// Zod 4's z.uuid() rejects version-0 ids\nconst ok = UUID;",
      'e.ts': "/* not z.string().uuid() */ const ok = z.guid();",
    })).toEqual([
      'a.ts:1: const A = z.string().uuid();',
      'b.ts:1: const B = z.uuid();',
      "c.ts:1: id: z.string().min(1).uuid({ message: 'bad' }),",
      "f.ts:1: id: z.string().uuid('bad id'),",
      'g.ts:3: .uuid(',
      'h.ts:1: bundleId: z.uuidv4(),',
    ]);
  });
});
