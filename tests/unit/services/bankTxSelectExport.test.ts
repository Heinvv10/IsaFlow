/**
 * The all-accounts export (up to 50 000 rows) uses TX_SELECT_EXPORT: TX_SELECT minus the per-row settled-document
 * count (a correlated chain the export never prints). Pins that the replacement really happened and changed nothing else.
 */
import { describe, expect, it } from 'vitest';
import { TX_SELECT, TX_SELECT_EXPORT } from '@/modules/accounting/services/bank/bankTxQueryFragments';
import { settledDocumentCountSql } from '@/modules/accounting/services/bank/settledDocumentSql';

describe('TX_SELECT_EXPORT', () => {
  it('drops only the settled-document count', () => {
    const fragment = `${settledDocumentCountSql('bt')} AS settled_document_count`;
    expect(TX_SELECT).toContain(fragment);
    expect(TX_SELECT_EXPORT).not.toContain(fragment);
    expect(TX_SELECT_EXPORT).toBe(TX_SELECT.replace(fragment, 'NULL::INT AS settled_document_count'));
  });
});
