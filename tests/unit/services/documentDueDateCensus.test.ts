/**
 * A source-text RATCHET (it proves nothing about behaviour; the due-date tests beside each creator do): every writer of a
 * customer or supplier invoice either dates it from the contact's terms and then the company default (it names one of the
 * shared derivations), or is listed here with the reason it takes the date from its own source. A new document creator
 * that writes no due date, or a hard-coded +30, fails this and has to choose (migration 960; Hein, 2026-11-05).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const DERIVATIONS = /\b(dueDateForContact|billDueDate|extractedBillDueDate|dueDateWithDefault|ownTermsDueDate)\b/;
const WRITES = /INSERT\s+INTO\s+(customer_invoices|supplier_invoices)\b/;

const OWN_DATE: Record<string, string> = {
  'src/modules/accounting/services/ap/migrationApService.ts': 'take-on file: the due date is a required column of the file',
  'src/modules/accounting/services/core/migrationImportService.ts': 'take-on file: the due date is a required column of the file',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const writers = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))]
  .map((abs) => ({ rel: relative(ROOT, abs), text: readFileSync(abs, 'utf8') }))
  .filter(({ text }) => WRITES.test(text));

describe('every invoice writer dates the document', () => {
  it('finds the writers (the pattern is not matching nothing)', () => {
    expect(writers.length).toBeGreaterThanOrEqual(15);
  });

  it('each names a terms derivation, or is allow-listed with a reason', () => {
    const undated = writers.filter(({ rel, text }) => !DERIVATIONS.test(text) && !(rel in OWN_DATE)).map(({ rel }) => rel);
    expect(undated).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    const found = writers.map(({ rel }) => rel);
    for (const rel of Object.keys(OWN_DATE)) expect(found, rel).toContain(rel);
  });

  it('no writer hard-codes thirty days for a due date', () => {
    const hardcoded = writers.filter(({ text }) => /due_date[^;]{0,160}(INTERVAL\s*'30\s*days'|\+\s*30\b)/.test(text)).map(({ rel }) => rel);
    expect(hardcoded).toEqual([]);
  });
});
