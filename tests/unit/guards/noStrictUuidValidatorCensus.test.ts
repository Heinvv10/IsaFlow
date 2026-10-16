/**
 * No id is validated with Zod 4's strict `.uuid()` / `z.uuid()`.
 *
 * Zod 4's uuid check enforces the RFC 4122 version nibble, so it refuses the
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
const STRICT_UUID = /\bz\s*\.\s*uuid\s*\(|\.\s*uuid\s*\(\s*(\{[^)]*\})?\s*\)/;

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

export function strictUuidOffenders(sources: Record<string, string>): string[] {
  return Object.entries(sources).flatMap(([path, text]) =>
    code(text).split('\n').flatMap((line, i) => (STRICT_UUID.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])));
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
      'd.ts': "// Zod 4's z.uuid() rejects version-0 ids\nconst ok = UUID;",
      'e.ts': "/* not z.string().uuid() */ const ok = z.guid();",
    })).toEqual([
      'a.ts:1: const A = z.string().uuid();',
      'b.ts:1: const B = z.uuid();',
      "c.ts:1: id: z.string().min(1).uuid({ message: 'bad' }),",
    ]);
  });
});
