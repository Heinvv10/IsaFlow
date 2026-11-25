/**
 * Round-10 breaker B10-2 / B10-3 (a, b): container shapes that used to read as a clean, smaller export.
 *   - B10-2: a row inside a container (plain rows or a page's $resources) that is an array, or carries a page marker, is a nested page:
 *     its rows would vanish into one bad row, so the file is refused whole;
 *   - B10-3a: $totalResults must equal the rows read across ALL pages (above or below);
 *   - B10-3b: a $-key on a page outside the known set ($Next, $TotalResults ...) is refused, never ignored.
 * Cases from the breaker's b10-c-shapes.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseSageExport, rowsOf, SageExportShapeError } from '@/modules/accounting/services/sage-migration/sageExportParser';

const po = (id: number) => ({ ID: id, DocumentNumber: `P${id}`, Date: '2026-02-01', Status: 'Pending', SupplierId: 3, Exclusive: 100, Tax: 15, Total: 115,
  Lines: [{ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1 }] });
const rows = (n: number, from = 1) => Array.from({ length: n }, (_, i) => po(from + i));
const shape = (file: Record<string, unknown>): string => {
  try { parseSageExport(file); return 'accepted'; } catch (e) {
    if (!(e instanceof SageExportShapeError)) throw e;
    return e.message;
  }
};

describe('B10-2: a nested page or an array among the rows', () => {
  it('a page inside a page, alone or beside a row, is refused (its rows would vanish into one bad row)', () => {
    expect(shape({ PurchaseOrders: { $totalResults: 2, $startIndex: 0, $resources: [po(1), { $totalResults: 50, $resources: rows(5, 10) }] } }))
      .toMatch(/PurchaseOrders: row 1 is a page \(it carries \$(totalResults|resources)\)/);
    expect(shape({ PurchaseOrders: { $resources: [{ $totalResults: 50, $next: 'x', $resources: rows(5, 10) }] } })).toMatch(/row 0 is a page/);
  });
  it('an array of arrays, and an array beside a row, are refused', () => {
    expect(shape({ PurchaseOrders: [rows(3), rows(3, 10)] })).toMatch(/PurchaseOrders: row 0 is an array/);
    expect(shape({ PurchaseOrders: [rows(3), po(20)] })).toMatch(/row 0 is an array/);
    expect(shape({ PurchaseOrders: { $resources: [po(1), [po(2)]] } })).toMatch(/row 1 is an array/);
  });
  it('a row carrying any page marker ($resources, $next, $totalResults, $startIndex), in any case, is refused', () => {
    expect(shape({ PurchaseOrders: [{ $totalResults: 50, $resources: { a: po(1) } }, po(2)] })).toMatch(/row 0 is a page/);
    for (const marker of ['$next', '$totalResults', '$startIndex', '$TotalResults', '$Next']) {
      expect(shape({ PurchaseOrders: [{ ...po(1), [marker]: 5 }] }), marker).toMatch(new RegExp(`row 0 is a page \\(it carries \\${marker}\\)`));
    }
  });
  it('plain rows and pages of plain rows still read', () => {
    expect(rowsOf(rows(3), 'PurchaseOrders')).toHaveLength(3);
    expect(rowsOf({ $resources: rows(3) }, 'PurchaseOrders')).toHaveLength(3);
    expect(rowsOf([{ $resources: rows(2) }, { $resources: rows(1, 5) }], 'PurchaseOrders')).toHaveLength(3);
  });
});

describe('B10-3a: $totalResults against the rows read across all pages', () => {
  it('a total BELOW the rows read is refused too (it was only checked above)', () => {
    expect(shape({ PurchaseOrders: { $totalResults: 1, $startIndex: 0, $resources: rows(5) } })).toMatch(/\$totalResults is 1 but 5 rows were read/);
  });
  it('a per-page total (page 1 says 3, 6 rows in all) is refused: the total is the export\'s, not a page\'s', () => {
    expect(shape({ PurchaseOrders: [{ $totalResults: 3, $startIndex: 0, $resources: rows(3) }, { $resources: rows(3, 10) }] })).toMatch(/\$totalResults is 3 but 6 rows were read/);
    expect(shape({ PurchaseOrders: [{ $startIndex: 0, $resources: rows(3) }, { $startIndex: 3, $totalResults: 4, $resources: rows(3, 10) }] })).toMatch(/\$totalResults is 4 but 6 rows/);
  });
  it('the total of the whole export on every page is accepted', () => {
    expect(shape({ PurchaseOrders: [{ $totalResults: 6, $startIndex: 0, $resources: rows(3) }, { $totalResults: 6, $startIndex: 3, $resources: rows(3, 10) }] })).toBe('accepted');
  });
});

describe('B10-3b: an unknown $-key on a page', () => {
  it('a re-cased $Next or $TotalResults is refused, not ignored', () => {
    expect(shape({ PurchaseOrders: { $Next: 'https://x/?$skip=3', $resources: rows(3) } })).toMatch(/PurchaseOrders: a page carries "\$Next", which is not a page key this import knows/);
    expect(shape({ PurchaseOrders: { $TotalResults: 99, $resources: rows(3) } })).toMatch(/"\$TotalResults"/);
    expect(shape({ PurchaseOrders: [{ $resources: rows(3) }, { $skip: 3, $resources: rows(3, 10) }] })).toMatch(/"\$skip"/);
  });
  it('the known keys ($resources, $totalResults, $startIndex, $itemsPerPage, $next, $back) are accepted', () => {
    expect(shape({ PurchaseOrders: [{ $totalResults: 6, $startIndex: 0, $itemsPerPage: 3, $next: null, $resources: rows(3) },
      { $totalResults: 6, $startIndex: 3, $itemsPerPage: 3, $back: 'x', $resources: rows(3, 10) }] })).toBe('accepted');
  });
});

describe('B11-1 (round 11): $next on a page that is not the last of an array of pages', () => {
  const U = 'https://accounting.sageone.co.za/api/2.0.0/PurchaseOrder/Get?$top=3&$skip=';
  it('a whole 2-page export as Sage gives it ($next on page 1, $back on page 2) is accepted', () => {
    expect(rowsOf([
      { $totalResults: 6, $startIndex: 0, $itemsPerPage: 3, $next: `${U}3`, $resources: rows(3) },
      { $totalResults: 6, $startIndex: 3, $itemsPerPage: 3, $back: `${U}0`, $resources: rows(3, 10) },
    ], 'PurchaseOrders')).toHaveLength(6);
  });
  it('a whole 3-page export ($next on pages 1 and 2, null on page 3) is accepted', () => {
    expect(rowsOf([
      { $totalResults: 7, $startIndex: 0, $next: `${U}3`, $resources: rows(3) },
      { $totalResults: 7, $startIndex: 3, $next: `${U}6`, $back: `${U}0`, $resources: rows(3, 10) },
      { $totalResults: 7, $startIndex: 6, $next: null, $back: `${U}3`, $resources: rows(1, 20) },
    ], 'PurchaseOrders')).toHaveLength(7);
  });
  it('a $next on the LAST page, or on a single page, is still a partial export', () => {
    expect(shape({ PurchaseOrders: [{ $next: `${U}3`, $resources: rows(3) }, { $next: `${U}6`, $resources: rows(3, 10) }] })).toMatch(/the last page has a \$next link, so the export stops before its end/);
    expect(shape({ PurchaseOrders: [{ $next: `${U}3`, $resources: rows(3) }] })).toMatch(/the last page has a \$next link/);
    expect(shape({ PurchaseOrders: { $next: `${U}3`, $resources: rows(3) } })).toMatch(/the last page has a \$next link/);
  });
});
