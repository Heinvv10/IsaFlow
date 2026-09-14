/**
 * Contact Directory Read Service
 *
 * List queries extracted from customers.ts and suppliers-list.ts so the MCP
 * read-tool layer can call the exact same functions the API routes use. SQL
 * text and parameter semantics are unchanged from the routes. No caching
 * lives here — cacheThrough wrapping (for the uncached-list case in
 * customers.ts, and the page-1 case in suppliers-list.ts) stays in the
 * routes.
 */

import { sql, withSavepoint } from '@/lib/neon';

type Row = Record<string, unknown>;

/**
 * True only if the customer belongs to companyId. Used to reject an invoice
 * that references another company's customer (a plain FK on customer_id
 * bypasses RLS and would otherwise let a cross-company customer be booked into
 * this company's invoice, then read back via the joined client_name/email).
 */
export async function customerBelongsToCompany(companyId: string, customerId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM customers
    WHERE id = ${customerId}::uuid AND company_id = ${companyId} AND deleted_at IS NULL
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

/**
 * Refusal raised when a caller supplies a customer id that is not this
 * company's. Typed so a route can answer 4xx instead of 500.
 */
export class CustomerNotInCompanyError extends Error {
  readonly code = 'CUSTOMER_NOT_FOUND';
  constructor(customerId: string) {
    super(`Customer ${customerId} was not found for this company`);
    this.name = 'CustomerNotInCompanyError';
  }
}

/**
 * Savepoint names are sequenced: Postgres SHADOWS a re-declared name, so two
 * live subtransactions sharing one would make ROLLBACK TO unwind the wrong one.
 */
let ownershipSeq = 0;

/**
 * The tenant fence for a caller-supplied customer id, to be called BEFORE the
 * first write of any path that stores one.
 *
 * `customerBelongsToCompany` has existed since the MCP write tools were built,
 * but only the MCP layer ever called it: every HTTP route took `clientId` from
 * the request body and wrote it into `customer_invoices.client_id` /
 * `customer_id` (neither of which carries an (id, company_id) constraint, and
 * the RLS WITH CHECK only tests the invoice's own company_id). The fence
 * therefore lives HERE, in the service the route and the tool share, not in
 * either caller.
 *
 * An absent id is NOT a refusal — a quote, sales order or recurring-transaction
 * template may legitimately carry no customer, and every one of those columns
 * is nullable.
 *
 * The read takes a SAVEPOINT: a malformed id raises 22P02, which aborts the
 * request transaction withAuth opened, and a caller mid-batch would then see
 * 25P02 on every subsequent statement instead of this refusal. A malformed id
 * is by definition not a customer of this company, so it is refused; anything
 * else propagates.
 *
 * It asks ONLY about the tenant, not about `deleted_at`. This is a tenant
 * fence, and the paths it sits on are not all creates: quote update, sales-order
 * update, practice-client update, recurring-transaction execute and bank
 * allocation all take an id that an EXISTING company-owned row already carries,
 * and `softDeleteService.ts:69-73` soft-deletes a customer with no check for
 * open documents. Filtering deleted rows here therefore refuses edits that
 * previously saved, with no cross-tenant exposure closed by the refusal —
 * measured on `isaflow_dev`: editing a draft quote whose own-company customer
 * had been soft-deleted raised CustomerNotInCompanyError. It also matches the
 * guard this fix cites as its precedent, `customer-invoices-detail.ts:104-110`,
 * which has no such clause. `customerBelongsToCompany` /
 * `customersBelongToCompany` keep theirs: the MCP write tools call them to
 * decide whether a NEW document may name a customer, which is a different
 * question.
 */
export async function assertCustomerInCompany(
  companyId: string,
  customerId: string | null | undefined,
): Promise<void> {
  if (!customerId) return;
  const owned = await withSavepoint(
    `cust_own_${++ownershipSeq}`,
    async () => {
      const rows = (await sql`
        SELECT 1 FROM customers
        WHERE id = ${customerId}::uuid AND company_id = ${companyId}
        LIMIT 1
      `) as Row[];
      return rows.length > 0;
    },
  ).catch((err: unknown) => {
    // 22P02 invalid_text_representation — the id is not even a UUID.
    if ((err as { code?: string }).code === '22P02') return false;
    throw err;
  });
  if (!owned) throw new CustomerNotInCompanyError(customerId);
}

/**
 * True only if the supplier belongs to companyId. Mirror of
 * customerBelongsToCompany for the AP side: bank allocation resolves the
 * supplier name by id and posts against the AP control account, so a foreign
 * supplier_id would book this company's payment against another tenant's
 * creditor (and leak that supplier's name back in the journal description).
 */
export async function supplierBelongsToCompany(companyId: string, supplierId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM suppliers
    WHERE id = ${supplierId}::uuid AND company_id = ${companyId} AND deleted_at IS NULL
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

/**
 * True only if EVERY id belongs to companyId. One query for the whole set —
 * the bulk allocation tool checks up to 500 lines per call, and a per-line
 * round trip there is 500 queries before the first journal is posted.
 *
 * Mirrors accountsBelongToCompany: an empty set is vacuously true, and
 * duplicates are collapsed before the count comparison so a list naming the
 * same supplier twice still matches its single row.
 */
export async function suppliersBelongToCompany(
  companyId: string,
  supplierIds: string[],
): Promise<boolean> {
  const unique = [...new Set(supplierIds.filter((id) => typeof id === 'string' && id))];
  if (unique.length === 0) return true;
  const rows = (await sql`
    SELECT id FROM suppliers
    WHERE company_id = ${companyId} AND deleted_at IS NULL AND id = ANY(${unique}::uuid[])
  `) as Row[];
  return rows.length === unique.length;
}

/** Customer half of suppliersBelongToCompany — same contract. */
export async function customersBelongToCompany(
  companyId: string,
  customerIds: string[],
): Promise<boolean> {
  const unique = [...new Set(customerIds.filter((id) => typeof id === 'string' && id))];
  if (unique.length === 0) return true;
  const rows = (await sql`
    SELECT id FROM customers
    WHERE company_id = ${companyId} AND deleted_at IS NULL AND id = ANY(${unique}::uuid[])
  `) as Row[];
  return rows.length === unique.length;
}

export async function listCustomers(companyId: string, search?: string | null): Promise<Row[]> {
  const searchTerm = search && search.trim() ? `%${search.trim()}%` : null;

  if (searchTerm) {
    // Search queries are not cached — results change with every keystroke
    return (await sql`
      SELECT
        id, name, email, phone, contact_person,
        payment_terms, credit_limit, is_active,
        vat_number, registration_number,
        created_at
      FROM customers
      WHERE company_id = ${companyId}
        AND deleted_at IS NULL
        AND (name ILIKE ${searchTerm}
        OR email ILIKE ${searchTerm}
        OR vat_number ILIKE ${searchTerm}
        OR contact_person ILIKE ${searchTerm})
      ORDER BY name ASC
      LIMIT 200
    `) as Row[];
  }

  return (await sql`
    SELECT
      id, name, email, phone, contact_person,
      payment_terms, credit_limit, is_active,
      vat_number, registration_number,
      created_at
    FROM customers
    WHERE company_id = ${companyId}
      AND deleted_at IS NULL
    ORDER BY name ASC
    LIMIT 200
  `) as Row[];
}

export interface SupplierListOptions {
  search?: string | null;
  limit?: number;
  offset?: number;
}

export async function listSuppliers(
  companyId: string,
  opts: SupplierListOptions = {},
): Promise<{ suppliers: Row[]; total: number }> {
  const limitRaw = opts.limit;
  const offsetRaw = opts.offset;
  const limit = Number.isFinite(limitRaw) && (limitRaw as number) > 0 ? Math.min(limitRaw as number, 200) : 25;
  const offset = Number.isFinite(offsetRaw) && (offsetRaw as number) >= 0 ? Math.floor(offsetRaw as number) : 0;
  const searchTerm = opts.search && opts.search.trim() ? `%${opts.search.trim()}%` : null;

  if (searchTerm) {
    // Search queries are not cached — results change with every keystroke
    const [dataRows, countResult] = await Promise.all([
      sql`
        SELECT
          id, name, company_name, email, phone,
          contact_person, is_active,
          vat_number, payment_terms,
          created_at
        FROM suppliers
        WHERE company_id = ${companyId}
          AND deleted_at IS NULL
          AND (name ILIKE ${searchTerm}
          OR email ILIKE ${searchTerm}
          OR company_name ILIKE ${searchTerm}
          OR contact_person ILIKE ${searchTerm})
        ORDER BY name ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*) as total FROM suppliers
        WHERE company_id = ${companyId}
          AND deleted_at IS NULL
          AND (name ILIKE ${searchTerm}
          OR email ILIKE ${searchTerm}
          OR company_name ILIKE ${searchTerm}
          OR contact_person ILIKE ${searchTerm})
      `,
    ]);
    return { suppliers: dataRows as Row[], total: Number(countResult[0]?.total ?? 0) };
  }

  const [dataRows, countResult] = await Promise.all([
    sql`
      SELECT
        id, name, company_name, email, phone,
        contact_person, is_active,
        vat_number, payment_terms,
        created_at
      FROM suppliers
      WHERE company_id = ${companyId}
        AND deleted_at IS NULL
      ORDER BY name ASC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`
      SELECT COUNT(*) as total FROM suppliers
      WHERE company_id = ${companyId}
        AND deleted_at IS NULL
    `,
  ]);
  return { suppliers: dataRows as Row[], total: Number(countResult[0]?.total ?? 0) };
}
