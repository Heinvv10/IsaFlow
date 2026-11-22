/**
 * Migration 1018 round 12 (INFO b): the reversal link's "born here" rule and the late-claim base rule read
 * `gl_journal_entries.created_at = now()`. That holds only while every writer lets created_at default to now(), or
 * writes NOW() itself, and nothing UPDATEs it. A writer that passed a JS date (new Date()) would be refused by the link,
 * so this census fails first: every INSERT INTO gl_journal_entries that names created_at must give it NOW(), and no
 * statement may SET gl_journal_entries.created_at.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const files = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith('scripts/migrations/'));

/** Each INSERT INTO gl_journal_entries statement, up to its closing backtick or quote, with its file. */
function inserts(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    for (const m of src.matchAll(/INSERT INTO gl_journal_entries\b[\s\S]*?(?=`|';|",)/g)) out.push({ file, text: m[0] });
  }
  return out;
}

/** The value given for created_at in a column-list INSERT, or null when the column is not named. */
function createdAtValue(text: string): string | null {
  const cols = /gl_journal_entries\s*\(([^)]*)\)/.exec(text);
  if (!cols) return null;
  const names = cols[1]!.split(',').map((c) => c.trim().toLowerCase());
  const at = names.indexOf('created_at');
  if (at < 0) return null;
  const values = /VALUES\s*\(([\s\S]*)\)/i.exec(text.slice(cols.index + cols[0].length));
  if (!values) return 'UNPARSED';
  const parts: string[] = [];
  let depth = 0; let cur = '';
  for (const ch of values[1]!) {
    if (ch === '(' || ch === '{') depth += 1;
    if (ch === ')' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts[at] ?? 'UNPARSED';
}

describe('gl_journal_entries.created_at is always the transaction time (migration 1018 round 12)', () => {
  it('the parser reads the created_at value of a column-list INSERT', () => {
    expect(createdAtValue('INSERT INTO gl_journal_entries (id, created_at, status) VALUES (${a}, NOW(), ${b})')).toBe('NOW()');
    expect(createdAtValue('INSERT INTO gl_journal_entries (id, created_at) VALUES (${a}, ${new Date()})')).toBe('${new Date()}');
    expect(createdAtValue('INSERT INTO gl_journal_entries (id, status) VALUES ($1, $2)')).toBeNull();
  });

  it('every INSERT that names created_at gives it NOW()', () => {
    const found = inserts();
    expect(found.length).toBeGreaterThan(5);
    const named = found.map((i) => ({ file: i.file, v: createdAtValue(i.text) })).filter(({ v }) => v !== null);
    expect(named.map((n) => n.file)).toContain('src/modules/accounting/services/gl/yearEndJournalPoster.ts'); // not vacuous
    expect(named.filter(({ v }) => !/^now\(\)$/i.test(v!))).toEqual([]);
  });

  it('no statement sets gl_journal_entries.created_at', () => {
    const bad: string[] = [];
    for (const file of files) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      for (const m of src.matchAll(/UPDATE\s+gl_journal_entries\b[\s\S]*?(?=`|';)/gi)) {
        const set = /\bSET\b([\s\S]*?)(\bWHERE\b|\bFROM\b|$)/i.exec(m[0]);
        if (set && /(^|[\s,])created_at\s*=/i.test(set[1]!)) bad.push(file);
      }
    }
    expect(bad).toEqual([]);
  });
});
