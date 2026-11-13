/** A mention's link goes to a page that exists and mounts the panel for that record type (the mounts are rendered in tests/unit/components/commentsMounts*.test.tsx). */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commentRecordHref, type CommentRecordType } from '@/modules/accounting/services/comments/commentRecords';
import { isInAppPath } from '@/lib/inAppPath';

const ROOT = resolve(__dirname, '../../..');
const ID = '11111111-1111-4111-8111-111111111111';
const CASES: Array<[CommentRecordType, string, string, string]> = [
  ['customer_invoice', commentRecordHref('customer_invoice', ID), 'pages/accounting/customer-invoices/[invoiceId].tsx', 'recordType="customer_invoice"'],
  ['supplier_invoice', commentRecordHref('supplier_invoice', ID), 'pages/accounting/supplier-invoices/[invoiceId].tsx', 'recordType="supplier_invoice"'],
  ['bank_transaction', commentRecordHref('bank_transaction', ID, 'acct-1'), 'pages/accounting/bank-transactions/index.tsx', 'useBankLineDeepLink'],
];

describe.each(CASES)('%s link', (type, href, pageFile, marker) => {
  it('is an in-app path to a page that exists and carries the panel (or the deep link into the drawer that does)', () => {
    expect(isInAppPath(href)).toBe(true);
    expect(existsSync(resolve(ROOT, pageFile))).toBe(true);
    expect(readFileSync(resolve(ROOT, pageFile), 'utf8')).toContain(marker);
  });
  it('names the record', () => expect(href).toContain(ID));
});

it('the bank link carries the account and the line, which the bank page reads (?account_id=, ?line=)', () => {
  expect(commentRecordHref('bank_transaction', ID, 'acct-1')).toBe(`/accounting/bank-transactions?account_id=acct-1&line=${ID}`);
});
