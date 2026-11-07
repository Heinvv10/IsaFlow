/**
 * The stock-item batch writers check every id exists, then UPDATE in a second statement. If a row vanished in
 * between, the UPDATE would touch fewer rows than the batch: that must throw (a 500, which withAuth rolls back),
 * never report a partial batch as done.
 */
import { describe, expect, it } from 'vitest';
import { assertEveryItemUpdated } from '@/modules/accounting/services/items/stockItemLookup';

describe('assertEveryItemUpdated', () => {
  it('passes when every id in the batch was updated', () => {
    expect(() => assertEveryItemUpdated([{ id: 'a' }, { id: 'b' }], 2)).not.toThrow();
  });
  it.each([[[{ id: 'a' }], 2], [[], 1], [[{ id: 'a' }, { id: 'b' }], 1]])(
    'throws when %j rows were updated for a batch of %i', (rows, expected) => {
      expect(() => assertEveryItemUpdated(rows, expected)).toThrow(/rolled back/);
    });
});
