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
  // P4-D: the loan account's picker offers only what the side form takes (`intercompany_is_loan_class`: no bank, control, VAT or system
  // account, none holding bank-statement lines)
  const loanAccounts = (await sql`
    SELECT ga.id, ga.account_code || ' ' || ga.account_name AS label FROM gl_accounts ga
    WHERE ga.company_id = ${companyId}::UUID AND ga.is_active = true AND NOT ${isHeaderSql()}
      AND public.intercompany_is_loan_class(ga.id, ga.company_id)
    ORDER BY ga.account_code, ga.id LIMIT ${LIMIT + 1}
  `) as Row[];
  return {
    customers: refs(customers),
    suppliers: refs(suppliers),
    accounts: refs(accounts),
    loanAccounts: refs(loanAccounts),
    truncated: [customers, suppliers, accounts, loanAccounts].some((l) => l.length > LIMIT),
  };
}
