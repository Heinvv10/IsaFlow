/**
 * The cost-centre wipe of seed-phase5-payroll.ts, on its own so it can be run
 * (and tested) without the rest of the seed.
 *
 * Every RESTRICT foreign key to cost_centres, and what the wipe does about it
 * (checked against pg_constraint and the migrations, 2026-10-09):
 *   - payroll_employee_cost_allocations.cost_centre_id (451; NOT NULL): rows DELETED;
 *   - payroll_employees.cost_centre_id, assets.cost_centre_id (649): cleared;
 *   - gl_journal_lines.cc1_id / cc2_id (882), bank_transactions.cc1_id / cc2_id
 *     (878): cleared;
 *   - supplier_invoice_items, customer_invoice_items, credit_notes cc1_id /
 *     cc2_id, customers.default_cc1_id, gl_accounts.default_cc1_id /
 *     default_cc2_id (870): cleared;
 *   - cost_centres.parent_id (660): nothing — one DELETE removes the company's
 *     parents and children together and the check runs at the end of the
 *     statement. A child in ANOTHER company would still block it; creating one
 *     is refused (parents resolve within the company only).
 * Plus supplier_coding_rules.default_cost_centre_id: no FK, cleared so it does
 * not point at nothing. CASCADE / SET NULL references (aliases, GL mappings,
 * capture events) need nothing. Every statement is scoped to the one company.
 * Tags are CLEARED, never ledger rows deleted: a deleted posted line would
 * unbalance its journal, and a tag moves no figure. BU tags are left alone —
 * this wipe deletes no business unit.
 */
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export async function wipePhase5CostCentres(sql: Sql, companyId: string): Promise<void> {
  // NOT NULL: an allocation cannot be cleared, only removed.
  await sql`DELETE FROM payroll_employee_cost_allocations WHERE company_id = ${companyId}::uuid`;
  await sql`UPDATE payroll_employees SET cost_centre_id = NULL WHERE company_id = ${companyId}::uuid`;
  await sql`UPDATE gl_journal_lines SET cc1_id = NULL, cc2_id = NULL
            WHERE company_id = ${companyId}::uuid AND (cc1_id IS NOT NULL OR cc2_id IS NOT NULL)`;
  await sql`UPDATE bank_transactions SET cc1_id = NULL, cc2_id = NULL
            WHERE company_id = ${companyId}::uuid AND (cc1_id IS NOT NULL OR cc2_id IS NOT NULL)`;
  await sql`UPDATE supplier_invoice_items SET cc1_id = NULL, cc2_id = NULL
            WHERE (cc1_id IS NOT NULL OR cc2_id IS NOT NULL)
              AND supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${companyId}::uuid)`;
  await sql`UPDATE customer_invoice_items SET cc1_id = NULL, cc2_id = NULL
            WHERE (cc1_id IS NOT NULL OR cc2_id IS NOT NULL)
              AND invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${companyId}::uuid)`;
  await sql`UPDATE credit_notes SET cc1_id = NULL, cc2_id = NULL
            WHERE company_id = ${companyId}::uuid AND (cc1_id IS NOT NULL OR cc2_id IS NOT NULL)`;
  await sql`UPDATE customers SET default_cc1_id = NULL
            WHERE company_id = ${companyId}::uuid AND default_cc1_id IS NOT NULL`;
  await sql`UPDATE gl_accounts SET default_cc1_id = NULL, default_cc2_id = NULL
            WHERE company_id = ${companyId}::uuid AND (default_cc1_id IS NOT NULL OR default_cc2_id IS NOT NULL)`;
  await sql`UPDATE supplier_coding_rules SET default_cost_centre_id = NULL
            WHERE company_id = ${companyId}::uuid AND default_cost_centre_id IS NOT NULL`;
  await sql`UPDATE assets SET cost_centre_id = NULL
            WHERE company_id = ${companyId}::uuid AND cost_centre_id IS NOT NULL`;
  await sql`DELETE FROM cost_centres WHERE company_id = ${companyId}::uuid`;
}
