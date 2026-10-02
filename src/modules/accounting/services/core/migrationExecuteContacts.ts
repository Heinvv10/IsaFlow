/**
 * Contact inserts of a migration execute (customers, suppliers). Each returns
 * how many rows were really INSERTED: ON CONFLICT DO NOTHING hands back no row
 * for one it skipped, so the count comes from RETURNING, not from the input.
 * Column names are the migration-created ones: customers.billing_address,
 * suppliers.address (000_users_and_auth.sql).
 */
import { transaction } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { ParsedEntity } from './migrationParserService';

const inserted = (sets: DbRow[][]) => sets.filter(rows => rows.length > 0).length;

export async function insertCustomers(companyId: string, rows: ParsedEntity[]): Promise<number> {
  return inserted((await transaction((txSql) =>
    rows.map(cust => txSql`
      INSERT INTO customers (company_id, name, email, phone, vat_number, billing_address)
      VALUES (
        ${companyId}::UUID,
        ${cust.name},
        ${cust.email ?? null},
        ${cust.phone ?? null},
        ${cust.vatNumber ?? null},
        ${cust.address ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `)
  )) as DbRow[][]);
}

export async function insertSuppliers(companyId: string, rows: ParsedEntity[]): Promise<number> {
  return inserted((await transaction((txSql) =>
    rows.map(sup => txSql`
      INSERT INTO suppliers (company_id, name, email, phone, vat_number, address)
      VALUES (
        ${companyId}::UUID,
        ${sup.name},
        ${sup.email ?? null},
        ${sup.phone ?? null},
        ${sup.vatNumber ?? null},
        ${sup.address ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `)
  )) as DbRow[][]);
}
