/**
 * Round-12 breaker B12-5 and review R3: an array of pages must show it is one whole chain, or a page goes missing without a trace.
 *   - every page but the last carries a $next link; every page carries $totalResults or $startIndex;
 *   - a page that is not the last is full (its $itemsPerPage rows, when given);
 *   - a $next link that names a position ($skip / startIndex) names where the rows read so far end.
 * Cases from the breaker's b12-c-shapes.ts.
 */
import { describe, expect, it } from 'vitest';
import { nextLinkPosition, parseSageExport, SageExportShapeError } from '@/modules/accounting/services/sage-migration/sageExportParser';

const po = (id: number) => ({ ID: id, DocumentNumber: `P${id}`, Date: '2026-02-01', Status: 'Pending', SupplierId: 3, Exclusive: 100, Tax: 15, Total: 115,
  Lines: [{ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1 }] });
const rows = (n: number, from = 1) => Array.from({ length: n }, (_, i) => po(from + i));
const U = 'https://accounting.sageone.co.za/api/2.0.0/PurchaseOrder/Get?companyid=1&$top=3&$skip=';
const shape = (PurchaseOrders: unknown): string => {
  try { parseSageExport({ PurchaseOrders }); return 'accepted'; } catch (e) {
    if (!(e instanceof SageExportShapeError)) throw e;
    return e.message;
  }
};

describe('B12-5 / R3: a chain of pages', () => {
  it('$next-only pages with the MIDDLE page missing are refused (no $totalResults or $startIndex to tell)', () => {
    expect(shape([{ $itemsPerPage: 3, $next: `${U}3`, $resources: rows(3) }, { $itemsPerPage: 3, $next: `${U}9`, $resources: rows(3, 7) }, { $itemsPerPage: 3, $resources: rows(1, 10) }]))
      .toMatch(/page 1 of 3 carries neither \$totalResults nor \$startIndex/);
  });
  it('a $next naming a position other than where the rows read end is refused', () => {
    expect(shape([{ $startIndex: 0, $next: `${U}3`, $resources: rows(3) }, { $startIndex: 3, $next: `${U}9`, $resources: rows(3, 4) }, { $startIndex: 6, $resources: rows(2, 10) }]))
      .toMatch(/page 2's \$next link continues at row 9, but 6 rows were read up to it/);
  });
  it('a page short of its $itemsPerPage that is not the last is refused', () => {
    expect(shape([{ $startIndex: 0, $itemsPerPage: 3, $next: `${U}2`, $resources: rows(2) }, { $startIndex: 2, $itemsPerPage: 3, $resources: rows(2, 10) }]))
      .toMatch(/page 1 holds 2 rows of its \$itemsPerPage 3 but is not the last page/);
  });
  it('a page that is not the last without $next is refused (R3: so a missing LAST page of $startIndex-only pages shows too)', () => {
    expect(shape([{ $startIndex: 0, $resources: rows(3) }, { $startIndex: 3, $resources: rows(3, 4) }])).toMatch(/page 1 of 2 has no \$next link/);
    expect(shape([{ $next: `${U}3`, $resources: rows(3) }, { $resources: rows(3, 4) }, { $resources: rows(3, 20) }])).toMatch(/page 1 of 3 carries neither/);
  });
  it('$itemsPerPage that is not a whole number is refused on a chain', () => {
    expect(shape([{ $startIndex: 0, $itemsPerPage: 'lots', $next: `${U}3`, $resources: rows(3) }, { $startIndex: 3, $resources: rows(1, 4) }])).toMatch(/\$itemsPerPage must be a whole number/);
  });
  it('a whole chain is accepted: positions right, a short LAST page, an empty trailing page, links without a position', () => {
    expect(shape([{ $totalResults: 7, $startIndex: 0, $itemsPerPage: 3, $next: `${U}3`, $resources: rows(3) },
      { $totalResults: 7, $startIndex: 3, $itemsPerPage: 3, $next: `${U}6`, $back: `${U}0`, $resources: rows(3, 10) },
      { $totalResults: 7, $startIndex: 6, $itemsPerPage: 3, $back: `${U}3`, $resources: rows(1, 20) }])).toBe('accepted');
    expect(shape([{ $totalResults: 3, $next: `${U}3`, $resources: rows(3) }, { $totalResults: 3, $resources: [] }])).toBe('accepted');
    expect(shape([{ $totalResults: 4, $next: 'opaque-cursor', $resources: rows(3) }, { $totalResults: 4, $resources: rows(1, 9) }])).toBe('accepted');
  });
});

describe('nextLinkPosition', () => {
  it('reads $skip, skip, $startIndex, startIndex in any case; anything else is no position', () => {
    expect([`${U}6`, 'https://x/?skip=4', 'https://x/?$StartIndex=10', 'https://x/?startindex=2'].map(nextLinkPosition)).toEqual([6, 4, 10, 2]);
    expect(['https://x/?page=2', 'https://x/?$skip=abc', 3, null].map(nextLinkPosition)).toEqual([null, null, null, null]);
  });
  it('L2 (round 13): a relative link is read against a placeholder base', () => {
    expect(['/items?$skip=100', 'items?skip=4', '?$startIndex=7'].map(nextLinkPosition)).toEqual([100, 4, 7]);
    expect(nextLinkPosition('/items?page=2')).toBeNull(); // page=N: an open question
  });
});
