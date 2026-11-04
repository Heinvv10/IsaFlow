/**
 * A stable React key for a purchase-order line row, made once when the row is (new-PO page and the detail editor
 * alike): a module counter, so keys never repeat within a page's life and never depend on the row's position or on
 * `crypto.randomUUID` (unavailable outside a secure context).
 */
let next = 0;

export function newPoLineKey(): string {
  next += 1;
  return `po-line-${next}`;
}
