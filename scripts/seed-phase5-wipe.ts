/**
 * The cost-centre wipe of seed-phase5-payroll.ts, on its own so it can be run
 * (and tested) without the rest of the seed.
 *
 * Every column that names a cost centre through a RESTRICT foreign key is
 * cleared first — scoped to the one company — or the DELETE dies on 23503:
 * the journal and bank lines (878 / 882), the document lines and credit notes
 * and the customer / account defaults (870), employees and assets (649), and the
 * coding-rule default (no FK, but it would point at nothing). The parent links
 * between the company's own centres (660) need nothing: one DELETE removes
 * parent and child together, and the check runs at the end of the statement.
 * Tags are CLEARED, never rows deleted: a deleted posted line would unbalance
 * its journal, and a tag moves no figure. BU tags are left alone — this wipe
 * deletes no business unit.
 */
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export async function wipePhase5CostCentres(sql: Sql, companyId: string): Promise<void> {
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
