/**
 * WP1 PR-B: the line bucket's JS mirror (lineBucketOf) and the shape of its SQL (LINE_BUCKET_SQL). Precedence is
 * the whole point: pending, then excluded (a kept match does not make it allocated), then allocated (a matched line
 * or a booked status — provisional and the Sage 'reconciled' line with no match included), then suggested, else
 * unallocated. The SQL and the mirror are compared row by row against Postgres in
 * tests/integration/bank-account-summary-partition.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { LINE_BUCKET_SQL, lineBucketOf, type LineBucketFields } from '@/modules/accounting/services/bank/bankLineBucket';

const line = (over: Partial<Record<keyof LineBucketFields, unknown>>): LineBucketFields =>
  ({ feedState: 'posted', status: 'imported', ...over }) as LineBucketFields;

describe('lineBucketOf', () => {
  it.each([
    ['imported, nothing set', {}, 'unallocated'],
    ['NULL status (mapTxRow renders it "null")', { status: 'null' }, 'unallocated'],
    ['imported with a suggested account', { suggestedGlAccountId: 'g' }, 'suggested'],
    ['imported with a suggested supplier', { suggestedSupplierId: 's' }, 'suggested'],
    ['imported with a suggested customer', { suggestedClientId: 'c' }, 'suggested'],
    ['imported with only an allocation type', { allocationType: 'account' }, 'suggested'],
    ['NULL status with a suggestion', { status: 'null', suggestedGlAccountId: 'g' }, 'suggested'],
    ['imported with a matched line', { matchedJournalLineId: 'jl' }, 'allocated'],
    ['provisional', { status: 'provisional' }, 'allocated'],
    ['allocated', { status: 'allocated', matchedJournalLineId: 'jl' }, 'allocated'],
    ['matched', { status: 'matched' }, 'allocated'],
    ['reconciled with no matched line (Sage)', { status: 'reconciled' }, 'allocated'],
    ['provisional with a suggestion still allocated', { status: 'provisional', suggestedGlAccountId: 'g' }, 'allocated'],
    ['excluded', { status: 'excluded' }, 'excluded'],
    ['excluded that kept its match', { status: 'excluded', matchedJournalLineId: 'jl' }, 'excluded'],
    ['excluded with a suggestion', { status: 'excluded', suggestedGlAccountId: 'g' }, 'excluded'],
    ['pending at the bank', { feedState: 'pending' }, 'pending'],
    ['removed by the bank', { feedState: 'removed' }, 'pending'],
  ] as const)('%s → %s', (_name, over, bucket) => {
    expect(lineBucketOf(line(over))).toBe(bucket);
  });
});

describe('LINE_BUCKET_SQL', () => {
  const arm = (bucket: string) => LINE_BUCKET_SQL.indexOf(`THEN '${bucket}'`);

  it('tests the arms in the mirror\'s order: pending, excluded, allocated, suggested, else unallocated', () => {
    const order = ['pending', 'excluded', 'allocated', 'suggested'].map(arm);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(LINE_BUCKET_SQL).toMatch(/ELSE 'unallocated'\s+END$/);
  });

  it('counts every booked status as allocated, provisional and reconciled included', () => {
    expect(LINE_BUCKET_SQL).toContain("bt.status IN ('allocated', 'matched', 'reconciled', 'provisional')");
  });

  it('is a fixed literal over bt: no placeholder, no other alias', () => {
    expect(LINE_BUCKET_SQL).not.toMatch(/\$\{|\$\d/);
    const aliases = new Set([...LINE_BUCKET_SQL.matchAll(/\b([a-z_]+)\.[a-z_]+/g)].map((m) => m[1]));
    expect([...aliases]).toEqual(['bt']);
  });
});
