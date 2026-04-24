/**
 * Static wrap-registry test — asserts every operation in `flowOperationCatalog`
 * that is expected to be wired is actually referenced by `withFlowMeter(...)`
 * in its route file.  Catches accidental unwraps in future refactors without
 * re-testing the middleware contract (see withFlowMeter.test.ts for that).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FlowOperationCode } from '@/modules/billing/services/flowOperationCatalog';

const ROOT = resolve(__dirname, '..', '..', '..', '..');

// Operations that MUST be wrapped in a route, with the file(s) they live in.
// Operations not yet wired (e.g. compliance.export, audit.export, bank.allocate)
// are intentionally excluded until their route is wrapped.
const WIRED: Record<FlowOperationCode, string[] | null> = {
  'bank.import':          ['pages/api/accounting/bank-transactions-import.ts'],
  'invoice.create':       ['pages/api/accounting/customer-invoices-create.ts'],
  'report.tb':            ['pages/api/accounting/reports-trial-balance.ts'],
  'afs.generate':         ['pages/api/accounting/afs/generate-pack.ts'],
  'supplier.bill.create': ['pages/api/accounting/supplier-invoices.ts'],
  'payment.record':       [
    'pages/api/accounting/customer-payments.ts',
    'pages/api/accounting/supplier-payments.ts',
  ],
  'journal.create':       ['pages/api/accounting/journal-entries.ts'],
  'report.pnl':           ['pages/api/accounting/reports-income-statement.ts'],
  'report.bs':            ['pages/api/accounting/reports-balance-sheet.ts'],
  'report.age':           [
    'pages/api/accounting/reports-ar-aging.ts',
    'pages/api/accounting/reports-ap-aging.ts',
  ],
  'vat.return':           ['pages/api/accounting/reports-vat-return.ts'],
  'yearend.close':        ['pages/api/accounting/year-end.ts'],
  // Deferred — no route yet.
  'bank.allocate':        null,
  'compliance.export':    null,
  'audit.export':         null,
};

describe('withFlowMeter wrap registry', () => {
  for (const [code, files] of Object.entries(WIRED)) {
    if (files === null) {
      it.skip(`${code} — wrap deferred`, () => { /* intentionally deferred */ });
      continue;
    }
    for (const rel of files) {
      it(`${code} is wired in ${rel}`, () => {
        const source = readFileSync(resolve(ROOT, rel), 'utf-8');
        expect(source).toMatch(/from ['"]@\/lib\/billing\/withFlowMeter['"]/);
        // Match `withFlowMeter('code', ...` or `withFlowMeter("code", ...`.
        const pattern = new RegExp(`withFlowMeter\\(\\s*['"]${code.replace(/\./g, '\\.')}['"]`);
        expect(source).toMatch(pattern);
      });
    }
  }
});
