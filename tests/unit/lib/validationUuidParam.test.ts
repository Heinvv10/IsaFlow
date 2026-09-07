/**
 * `isUuidParam` — the guard four WS3 routes had each written out by hand.
 *
 * A dynamic route parameter is `string | string[] | undefined`: a repeated
 * query parameter arrives as an array, so the shape check is not optional
 * decoration. These routes answer a neutral 404 on a bad id, so a guard that
 * lets an array through hands `${id}::uuid` an array and turns that 404 into a
 * 500 — which tells a prober that the id was at least well-formed.
 */
import { describe, it, expect } from 'vitest';
import { isUuidParam } from '@/lib/validation';

const ID = '33333333-3333-4333-8333-333333333333';

describe('isUuidParam', () => {
  it('accepts a well-formed uuid string, in either case', () => {
    expect(isUuidParam(ID)).toBe(true);
    expect(isUuidParam(ID.toUpperCase())).toBe(true);
  });

  it('rejects the array a repeated query parameter produces, even of valid uuids', () => {
    expect(isUuidParam([ID])).toBe(false);
    expect(isUuidParam([ID, ID])).toBe(false);
  });

  it('rejects a missing parameter and a non-string', () => {
    expect(isUuidParam(undefined)).toBe(false);
    expect(isUuidParam(null)).toBe(false);
    expect(isUuidParam(42)).toBe(false);
  });

  it('rejects anything that is not the full 36-character shape', () => {
    expect(isUuidParam('')).toBe(false);
    expect(isUuidParam('not-a-uuid')).toBe(false);
    expect(isUuidParam(ID.slice(0, 35))).toBe(false);
    expect(isUuidParam(`${ID} OR 1=1`)).toBe(false);
    expect(isUuidParam(`${ID}\n`)).toBe(false);
  });
});
