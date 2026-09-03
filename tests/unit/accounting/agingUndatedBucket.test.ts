/**
 * An invoice with no usable date at all must land in a bucket by DECISION,
 * not by accident.
 *
 * getAgingBucket previously reached the oldest bucket via NaN: an Invalid Date
 * makes every comparison false, so control fell through to the final return.
 * That works until someone reorders the branches, at which point undated debt
 * silently moves bucket with nothing to catch it.
 */
import { describe, it, expect } from 'vitest';
import { getAgingBucket, calculateAgingBuckets } from '@/modules/accounting/utils/aging';

const AS_AT = new Date('2026-06-30T00:00:00Z');

describe('aging an invoice whose date is unknown', () => {
  it('puts an unparseable date in the oldest bucket, deliberately', () => {
    expect(getAgingBucket(new Date('not a date'), AS_AT)).toBe('days120Plus');
    expect(getAgingBucket(new Date(String(null)), AS_AT)).toBe('days120Plus');
  });

  it('does not depend on the ordering of the overdue branches', () => {
    // A real date still buckets normally, so the guard above has not swallowed
    // the ordinary path.
    expect(getAgingBucket(new Date('2026-07-15T00:00:00Z'), AS_AT)).toBe('current');
    expect(getAgingBucket(new Date('2026-06-15T00:00:00Z'), AS_AT)).toBe('days30');
    expect(getAgingBucket(new Date('2026-01-15T00:00:00Z'), AS_AT)).toBe('days120Plus');
  });

  it('still counts an undated invoice into the entity total', () => {
    const buckets = calculateAgingBuckets(
      [{
        id: 'i1', entityId: 'e1', entityName: 'E',
        dueDate: 'null', totalAmount: 500, amountPaid: 0, balance: 500,
      }],
      AS_AT,
    );

    // Dropping it would be the omission this whole change exists to stop.
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.total).toBeCloseTo(500, 2);
    expect(buckets[0]!.days120Plus).toBeCloseTo(500, 2);
  });
});
