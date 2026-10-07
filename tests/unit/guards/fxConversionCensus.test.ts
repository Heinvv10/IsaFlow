/**
 * FX PR0 census — a source-text RATCHET ONLY; the behaviour is proved by
 * tests/unit/accounting/functionalAmounts.test.ts and the parity test in
 * tests/integration/fx-pr0-refusals.int.test.ts.
 *
 * A document's rand figure is computed in ONE place: public.fx_functional in
 * SQL, or its exact-decimal twin toFunctional in TypeScript. A multiplication
 * by an exchange rate anywhere else is a second conversion, and the FX plan
 * rests on there being one: GL and subledger only foot if they round alike.
 * Five such sites existed (customerInvoiceCreateService, customerInvoiceDraftEdit,
 * supplierInvoiceService, supplierInvoiceDraftUpdate, customer-invoices/new.tsx),
 * all in float. Read from disk, not git ls-files, so an untracked file cannot
 * pass falsely.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** The one TypeScript conversion. */
const ALLOWED = new Set(['src/modules/accounting/services/shared/functionalAmounts.ts']);

const RATE = String.raw`[\w.!?]*(?:exchange_?rate|fx_?rate)\w*`;
const MULTIPLY_BY_RATE = new RegExp(String.raw`${RATE}\s*\*|\*\s*${RATE}`, 'i');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const isComment = (line: string) => /^\s*(\*|\/\/|\/\*|--)/.test(line);

export function conversionSites(): string[] {
  const sites: string[] = [];
  for (const abs of ['src', 'pages', 'scripts'].flatMap((d) => walk(join(ROOT, d)))) {
    const rel = relative(ROOT, abs);
    if (ALLOWED.has(rel)) continue;
    readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (!isComment(line) && MULTIPLY_BY_RATE.test(line)) sites.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return sites;
}

describe('exchange-rate conversions happen in one place', () => {
  it('no code multiplies by an exchange rate outside functionalAmounts.ts', () => {
    expect(conversionSites()).toEqual([]);
  });

  it('the pattern catches the shapes it must (self-test)', () => {
    for (const line of [
      'const functionalTotal = Math.round(totalAmount * invExchangeRate * 100) / 100;',
      'functional_total = ${Math.round(totalAmount * plan.exchangeRate * 100) / 100},',
      'const zarTotal = Math.round(total * form.exchangeRate * 100) / 100;',
      'SELECT total_amount * exchange_rate FROM customer_invoices',
      'const x = fxRate * total;',
    ]) expect(MULTIPLY_BY_RATE.test(line), line).toBe(true);
    for (const line of ['const rate = taxRate * 100;', 'exchangeRate: Number(row.exchange_rate ?? 1)']) {
      expect(MULTIPLY_BY_RATE.test(line), line).toBe(false);
    }
  });
});
