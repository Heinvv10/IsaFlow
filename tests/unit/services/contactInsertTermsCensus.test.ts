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
const INSERT = /INSERT\s+INTO\s+(suppliers|customers)\s*\(([^)]*)\)/gi;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const inserts = ['src', 'pages', 'scripts'].flatMap((d) => walk(join(ROOT, d)))
  .flatMap((abs) => [...readFileSync(abs, 'utf8').matchAll(INSERT)].map((m) => ({ rel: relative(ROOT, abs), table: m[1]!, columns: m[2]! })));

describe('every contact INSERT names its payment terms', () => {
  it('finds the writers (the pattern is not matching nothing)', () => {
    expect(inserts.length).toBeGreaterThanOrEqual(12);
  });

  it('each lists payment_terms and payment_terms_type', () => {
    const silent = inserts.filter(({ columns }) => !/\bpayment_terms\b/.test(columns) || !/\bpayment_terms_type\b/.test(columns))
      .map(({ rel, table }) => `${rel} (${table})`);
    expect(silent).toEqual([]);
  });
});
