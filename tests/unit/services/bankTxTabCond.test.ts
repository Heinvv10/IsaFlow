/**
 * Which lines each bank-transactions tab asks for (Hein, 2026-11-12; migration 980), and the query string the page
 * builds for it. The SQL itself is exercised in tests/integration/bank-tx-reviewed-reconciled.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseReconFilter, tabStatusCond } from '@/modules/accounting/services/bank/bankTxTabCond';
import { bankTxQueryParams, type BankTxQuery } from '@/components/accounting/bank-transactions/bankTxQuery';

const q = (over: Partial<BankTxQuery>): BankTxQuery => ({
  bankAccountId: 'b1', tab: 'new', page: 1, pageSize: 50, fromDate: '', toDate: '', fromAmount: '', toAmount: '',
  search: '', sortOrder: 'desc', allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all',
  reconFilter: 'all', ...over,
});

describe('tabStatusCond', () => {
  it('New: unallocated, plus allocated or matched lines nobody has reviewed', () => {
    expect(tabStatusCond('imported')).toBe(
      "AND (bt.status = 'imported' OR (bt.status IN ('allocated', 'matched') AND bt.reviewed_at IS NULL))");
  });

  it('Reviewed: reviewed lines and every reconciled line, whatever the recon filter on New', () => {
    expect(tabStatusCond('matched')).toBe(
      "AND (bt.status = 'reconciled' OR (bt.status IN ('allocated', 'matched') AND bt.reviewed_at IS NOT NULL))");
    expect(tabStatusCond('imported', 'reconciled')).toBe(tabStatusCond('imported'));
  });

  it('Reviewed narrows to unreconciled or reconciled lines', () => {
    expect(tabStatusCond('matched', 'unreconciled')).toMatch(/ AND bt\.status <> 'reconciled'$/);
    expect(tabStatusCond('matched', 'reconciled')).toMatch(/ AND bt\.status = 'reconciled'$/);
    expect(tabStatusCond('matched', 'all')).toBe(tabStatusCond('matched'));
  });

  it('a plain status passes through only from the allow-list; anything else matches nothing', () => {
    expect(tabStatusCond('excluded')).toBe("AND bt.status = 'excluded'");
    expect(tabStatusCond("excluded' OR '1'='1")).toBe('AND FALSE');
    expect(tabStatusCond('')).toBe('AND FALSE');
  });
});

describe('parseReconFilter', () => {
  it('accepts the three values and nothing else', () => {
    expect(['all', 'unreconciled', 'reconciled', 'x', undefined, ['reconciled']].map(parseReconFilter))
      .toEqual(['all', 'unreconciled', 'reconciled', undefined, undefined, undefined]);
  });
});

describe('bankTxQueryParams', () => {
  it('maps each tab to the status the API reads', () => {
    expect(['new', 'reviewed', 'excluded'].map((tab) => bankTxQueryParams(q({ tab: tab as BankTxQuery['tab'] })).get('status')))
      .toEqual(['imported', 'matched', 'excluded']);
  });

  it('sends recon_filter on Reviewed only, and only when narrowed', () => {
    expect(bankTxQueryParams(q({ tab: 'reviewed', reconFilter: 'reconciled' })).get('recon_filter')).toBe('reconciled');
    expect(bankTxQueryParams(q({ tab: 'reviewed', reconFilter: 'all' })).has('recon_filter')).toBe(false);
    expect(bankTxQueryParams(q({ tab: 'new', reconFilter: 'reconciled' })).has('recon_filter')).toBe(false);
  });
});
