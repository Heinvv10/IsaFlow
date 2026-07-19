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

import { sql } from '@/lib/neon';

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
