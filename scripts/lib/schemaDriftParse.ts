/**
 * The schema-drift audit's model of the expected schema, parsed from the
 * migration files' text: CREATE TABLE / ADD COLUMN add, DROP COLUMN / DROP
 * TABLE remove, RENAME moves. Comments are stripped first (a `--` or `/*` inside
 * a single-quoted literal on the same line is text, not a comment). A statement built
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

// Every CREATE TABLE <name> ( ... must be read by CT_RE; one it misses would vanish from the audit.
const CT_HEAD_RE = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?(\w+)\s*\(/gi;

/**
 * Removes `--` and `/* *\/` comments, leaving a comment marker inside a single-quoted literal
 * (DEFAULT 'a--b') alone. Quote state restarts on each line outside a block comment, so a literal
 * this scan misreads (E'\'' escapes, dollar quotes) can only keep a comment on its own line in the
 * text; inside a CREATE TABLE that leaves the column list unbalanced, which throws below.
 */
export function stripSqlComments(src: string): string {
  let out = '';
  let inQuote = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!, next = src[i + 1];
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      else if (c === '\n') out += c;
      continue;
    }
    if (c === '\n') { inQuote = false; out += c; continue; }
    if (!inQuote && c === '-' && next === '-') {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
      continue;
    }
    if (!inQuote && c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (c === "'") inQuote = !inQuote;
    out += c;
  }
  return out;
}

const NON_COL_PREFIXES = new Set([
  'constraint', 'primary', 'foreign', 'unique', 'check', 'like', 'exclude',
  'partition', 'generated', 'index',
]);

export function parseExpectedSchema(migDir: string = MIG_DIR): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>();
  const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();

  for (const f of files) {
    const src = readFileSync(join(migDir, f), 'utf8');
    const clean = stripSqlComments(src);
    let m: RegExpExecArray | null;

    const heads: number[] = [];
    CT_HEAD_RE.lastIndex = 0;
    while ((m = CT_HEAD_RE.exec(clean)) !== null) heads.push(m.index);

    CT_RE.lastIndex = 0;
    while ((m = CT_RE.exec(clean)) !== null) {
      const table = m[1]!.toLowerCase();
      if (heads[0] !== m.index) {
        throw new Error(
          `schemaDriftParse: a CREATE TABLE in ${f} could not be read (no closing ");" found for it); ` +
          `the audit would silently skip that table`,
        );
      }
      heads.shift();
      if (!expected.has(table)) expected.set(table, new Set());
      const cols = expected.get(table)!;
      let depth = 0, buf = '', inQuote = false;
      const parts: string[] = [];
      for (const c of m[2]!) {
        // A comma or parenthesis inside a single-quoted literal (DEFAULT '{80,100,120}') is text, not
        // structure. A '' escape toggles twice, so it stays inside the literal. This is a scan, not a
        // SQL lexer: E'' backslash escapes and dollar quotes are not modelled. Each leaves a quote or
        // parenthesis unbalanced, which throws below instead of silently dropping the table's later
        // columns from the audit.
        if (c === "'") inQuote = !inQuote;
        else if (!inQuote && c === '(') depth++;
        else if (!inQuote && c === ')') depth--;
        if (c === ',' && depth === 0 && !inQuote) { parts.push(buf); buf = ''; }
        else buf += c;
      }
      if (buf.trim()) parts.push(buf);
      if (inQuote || depth !== 0) {
        throw new Error(
          `schemaDriftParse: unbalanced quote/parenthesis in CREATE TABLE ${table} (${f}); ` +
          `the column list cannot be read, so the audit would silently skip its columns`,
        );
      }
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const first = trimmed.split(/\s+/)[0]!.toLowerCase();
        if (NON_COL_PREFIXES.has(first)) continue;
        const col = trimmed.split(/\s+/)[0]!.replace(/"/g, '').toLowerCase();
        if (/^\w+$/.test(col)) cols.add(col);
      }
    }

    if (heads.length > 0) {
      throw new Error(
        `schemaDriftParse: a CREATE TABLE in ${f} could not be read (no closing ");" found for it); ` +
        `the audit would silently skip that table`,
      );
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
