/** The pick-lists of the side form: this company's own active customers, suppliers and postable accounts. */
import { sql } from '@/lib/neon';
import { isHeaderSql } from '@/modules/accounting/services/budgets/headerSql';
import type { NamedRef, SideOptions } from './connectionTypes';

/** One more than this many rows means the list was cut. */
const LIMIT = 5000;

type Row = { id: unknown; label: unknown };
const refs = (rows: Row[]): NamedRef[] => rows.slice(0, LIMIT).map((r) => ({ id: String(r.id), label: String(r.label) }));

export async function listSideOptions(companyId: string): Promise<SideOptions> {
  const customers = (await sql`
    SELECT id, name AS label FROM customers
    WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL ORDER BY name, id LIMIT ${LIMIT + 1}
  `) as Row[];
  const suppliers = (await sql`
    SELECT id, name AS label FROM suppliers
    WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL ORDER BY name, id LIMIT ${LIMIT + 1}
  `) as Row[];
  const accounts = (await sql`
    SELECT ga.id, ga.account_code || ' ' || ga.account_name AS label FROM gl_accounts ga
    WHERE ga.company_id = ${companyId}::UUID AND ga.is_active = true AND NOT ${isHeaderSql()}
    ORDER BY ga.account_code, ga.id LIMIT ${LIMIT + 1}
  `) as Row[];
  return {
    customers: refs(customers),
    suppliers: refs(suppliers),
    accounts: refs(accounts),
    truncated: [customers, suppliers, accounts].some((l) => l.length > LIMIT),
  };
}
