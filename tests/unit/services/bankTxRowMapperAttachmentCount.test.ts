/**
 * mapTxRow carries TX_SELECT's attachment_count to the grid. A query that does not select the column must leave the
 * count absent, never 0: "unknown" read as "no files" would silently un-highlight a line that has some.
 */
import { describe, expect, it } from 'vitest';
import { mapTxRow } from '@/modules/accounting/services/bank/bankTxRowMapper';

const ROW = {
  id: 'bt-1', bank_account_id: 'acct-1', transaction_date: '2026-06-01', amount: '-115.00',
  description: 'WOOLWORTHS', status: 'imported', feed_state: 'posted',
};

describe('mapTxRow attachment count', () => {
  it('maps a selected count, including 0, to a number', () => {
    expect(mapTxRow({ ...ROW, attachment_count: 2 }).attachmentCount).toBe(2);
    expect(mapTxRow({ ...ROW, attachment_count: '3' }).attachmentCount).toBe(3);
    expect(mapTxRow({ ...ROW, attachment_count: 0 }).attachmentCount).toBe(0);
  });

  it('leaves the count absent when the query did not select it', () => {
    expect(mapTxRow(ROW).attachmentCount).toBeUndefined();
    expect(mapTxRow({ ...ROW, attachment_count: null }).attachmentCount).toBeUndefined();
  });
});
