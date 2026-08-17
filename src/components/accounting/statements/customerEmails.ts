/**
 * Builds the customerId -> email lookup the bulk statement screen uses to decide
 * which customers can be emailed.
 *
 * Why this is a module rather than three lines inline: the statements page read
 * `custJson.data.customers`, but `GET /api/accounting/customers` returns the rows
 * as a BARE ARRAY (`apiResponse.success(res, rows)`). `.customers` was therefore
 * always undefined, the map stayed empty, every customer looked like it had no
 * email, and the bulk-email feature could never select anyone. No crash, no
 * error — the feature simply never worked.
 *
 * `pages/accounting/customers/index.tsx` reads the same endpoint correctly as
 * `(json.data ?? json) as Customer[]`, which is what confirmed the shape.
 *
 * Both shapes are accepted deliberately: the sibling `customer-statements`
 * endpoint DOES wrap its rows in `{ customers: [...] }`, and these two payloads
 * are consumed side by side in the same function.
 */

export interface CustomerEmailRow {
  id: string;
  email?: string | null;
}

type CustomersPayload =
  | CustomerEmailRow[]
  | { customers?: CustomerEmailRow[] }
  | null
  | undefined;

/** Normalises either payload shape to a flat row list. */
export function toCustomerRows(payload: CustomersPayload): CustomerEmailRow[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.customers)) return payload.customers;
  return [];
}

/**
 * customerId -> email (null when the customer has none). A row without an `id`
 * is skipped rather than keyed under `undefined`.
 */
export function buildCustomerEmailMap(payload: CustomersPayload): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of toCustomerRows(payload)) {
    if (!row?.id) continue;
    map.set(row.id, row.email ?? null);
  }
  return map;
}
