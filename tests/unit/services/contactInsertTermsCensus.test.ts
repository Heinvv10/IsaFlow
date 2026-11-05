/**
 * A source-text RATCHET (behaviour is proved by tests/integration/payment-terms-importers.int.test.ts): migration 960
 * drops the payment_terms column defaults, so every INSERT into suppliers or customers in the app and its scripts names
 * both terms columns and writes a real choice or NULL / NULL (not set). One that omits them stores NULL by accident
 * today and would read as a decision tomorrow; a new writer has to choose (Hein, 2026-11-05).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const NAMED = /INSERT\s+INTO\s+(suppliers|customers)\b/gi;

/** An INSERT whose column list this census cannot read (none, or built with ${...}) is listed here BY FILE, with the reason. */
const UNREADABLE_OK: Record<string, string> = {};

export interface ContactInsert { table: string; columns: string | null }

/** Every INSERT INTO suppliers|customers in `text`; `columns` is null when the list after it cannot be read. */
export function contactInserts(text: string): ContactInsert[] {
  return [...text.matchAll(NAMED)].map((m) => {
    const list = /^\s*\(([^)]*)\)/.exec(text.slice(m.index + m[0].length));
    return { table: m[1]!, columns: list && !list[1]!.includes('${') ? list[1]! : null };
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const inserts = ['src', 'pages', 'scripts'].flatMap((d) => walk(join(ROOT, d)))
  .flatMap((abs) => contactInserts(readFileSync(abs, 'utf8')).map((i) => ({ rel: relative(ROOT, abs), ...i })));

describe('contactInserts reads the column list (and says when it cannot)', () => {
  it('reads a plain list, a multi-line list, and flags no list / a built list as unreadable', () => {
    expect(contactInserts('INSERT INTO suppliers (company_id, name)')).toEqual([{ table: 'suppliers', columns: 'company_id, name' }]);
    expect(contactInserts('insert into customers\n  (a,\n b)')[0]!.columns).toContain('b');
    expect(contactInserts('INSERT INTO customers SELECT * FROM x')[0]!.columns).toBeNull();
    expect(contactInserts('INSERT INTO suppliers (company_id, ${extra})')[0]!.columns).toBeNull();
    expect(contactInserts('INSERT INTO suppliers_archive (a)')).toEqual([]);
  });
});

describe('every contact INSERT names its payment terms', () => {
  it('finds the writers (the pattern is not matching nothing)', () => {
    expect(inserts.length).toBeGreaterThanOrEqual(12);
  });

  it('each column list is readable, or its file is listed with a reason', () => {
    const unreadable = inserts.filter(({ columns, rel }) => columns === null && !(rel in UNREADABLE_OK)).map(({ rel, table }) => `${rel} (${table})`);
    expect(unreadable).toEqual([]);
  });

  it('each readable list names payment_terms and payment_terms_type', () => {
    const silent = inserts
      .filter(({ columns }) => columns !== null && (!/\bpayment_terms\b/.test(columns) || !/\bpayment_terms_type\b/.test(columns)))
      .map(({ rel, table }) => `${rel} (${table})`);
    expect(silent).toEqual([]);
  });
});
