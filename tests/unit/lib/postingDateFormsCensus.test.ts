/**
 * Product decision (Dev Team orchestrator for Hein, 22 Nov 2026): every document form that chooses a posting date
 * refuses a date in a closed or locked fiscal period up front, draft-saving forms included. A form may move to
 * warn-only only where a server test proves posting into that period is refused (follow-up #1757), and this list is
 * changed in that PR. A linter in test clothes: it pins the decision, the behaviour is tested in DateFieldFiscal.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const FORMS: Array<[file: string, pattern: RegExp]> = [
  ['src/components/accounting/customer-invoices/InvoiceHeaderFields.tsx', /date\('invoiceDate', 'Invoice date', \{[^}]*postingDate: true/],
  ['pages/accounting/credit-notes/new.tsx', /<DateField[^>]*postingDate/s],
  ['pages/accounting/supplier-credit-notes/new.tsx', /<DateField[^>]*postingDate/s],
  ['pages/accounting/supplier-invoices/new.tsx', /<DateField[^>]*postingDate/s],
  ['pages/accounting/supplier-payments/new.tsx', /<DateField[^>]*postingDate/s],
  ['pages/accounting/customer-payments/new.tsx', /<DateField[^>]*postingDate/s],
  ['pages/accounting/journal-entries/new.tsx', /<DateField[^>]*postingDate/s],
  ['pages/accounting/bank-transactions/new.tsx', /<DateField[^>]*postingDate/s],
];

describe('posting-date forms refuse a closed-period date', () => {
  it.each(FORMS)('%s', (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });
  it('the invoice edit page does not switch the block off', () => {
    expect(read('pages/accounting/customer-invoices/edit/[invoiceId].tsx')).not.toMatch(/postingDate=\{false\}/);
  });
});
