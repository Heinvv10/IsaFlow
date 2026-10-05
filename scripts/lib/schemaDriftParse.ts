/**
 * The schema-drift audit's model of the expected schema, parsed from the
 * migration files' text: CREATE TABLE / ADD COLUMN add, DROP COLUMN / DROP
 * TABLE remove, RENAME moves. Comments are stripped first. A statement built
 * at runtime (EXECUTE format(...)) is invisible to it, so a migration that
 * drops a table must say DROP TABLE <name> literally, or the audit keeps
 * expecting the table and fails every deploy after it.
 *
 * Moved verbatim out of scripts/audit-schema-drift.ts so it can be unit-tested.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MIG_DIR = 'scripts/migrations/sql';

const CT_RE = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\)\s*(?:PARTITION\s+BY[^;]+)?;/gi;
const AT_RE = /ALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?(\w+)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+/gi;
const ATD_RE = /ALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?(\w+)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(\w+)/gi;
const ATR_RE = /ALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?(\w+)\s+RENAME\s+(?:COLUMN\s+)?(\w+)\s+TO\s+(\w+)/gi;
const DT_RE = /DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?(\w+)/gi;
const RT_RE = /ALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?(\w+)\s+RENAME\s+TO\s+(\w+)/gi;

const NON_COL_PREFIXES = new Set([
  'constraint', 'primary', 'foreign', 'unique', 'check', 'like', 'exclude',
  'partition', 'generated', 'index',
]);

export function parseExpectedSchema(migDir: string = MIG_DIR): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>();
  const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();

  for (const f of files) {
    const src = readFileSync(join(migDir, f), 'utf8');
    const clean = src.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    let m: RegExpExecArray | null;

    CT_RE.lastIndex = 0;
    while ((m = CT_RE.exec(clean)) !== null) {
      const table = m[1]!.toLowerCase();
      if (!expected.has(table)) expected.set(table, new Set());
      const cols = expected.get(table)!;
      let depth = 0, buf = '';
      const parts: string[] = [];
      for (const c of m[2]!) {
        if (c === '(') depth++;
        else if (c === ')') depth--;
        if (c === ',' && depth === 0) { parts.push(buf); buf = ''; }
        else buf += c;
      }
      if (buf.trim()) parts.push(buf);
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const first = trimmed.split(/\s+/)[0]!.toLowerCase();
        if (NON_COL_PREFIXES.has(first)) continue;
        const col = trimmed.split(/\s+/)[0]!.replace(/"/g, '').toLowerCase();
        if (/^\w+$/.test(col)) cols.add(col);
      }
    }

    AT_RE.lastIndex = 0;
    while ((m = AT_RE.exec(clean)) !== null) {
      const col = m[2]!.toLowerCase();
      if (NON_COL_PREFIXES.has(col)) continue;
      const table = m[1]!.toLowerCase();
      if (!expected.has(table)) expected.set(table, new Set());
      expected.get(table)!.add(col);
    }

    ATD_RE.lastIndex = 0;
    while ((m = ATD_RE.exec(clean)) !== null) {
      expected.get(m[1]!.toLowerCase())?.delete(m[2]!.toLowerCase());
    }

    ATR_RE.lastIndex = 0;
    while ((m = ATR_RE.exec(clean)) !== null) {
      const cols = expected.get(m[1]!.toLowerCase());
      if (cols?.has(m[2]!.toLowerCase())) {
        cols.delete(m[2]!.toLowerCase());
        cols.add(m[3]!.toLowerCase());
      }
    }

    DT_RE.lastIndex = 0;
    while ((m = DT_RE.exec(clean)) !== null) {
      expected.delete(m[1]!.toLowerCase());
    }

    RT_RE.lastIndex = 0;
    while ((m = RT_RE.exec(clean)) !== null) {
      const from = m[1]!.toLowerCase();
      const to = m[2]!.toLowerCase();
      if (expected.has(from)) {
        expected.set(to, expected.get(from)!);
        expected.delete(from);
      }
    }
  }
  return expected;
}
