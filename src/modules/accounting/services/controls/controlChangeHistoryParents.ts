import {hasHistoryIntentParent} from './controlChangeHistoryIntentParents';
import type {ControlTx} from './contracts';
/** Explicit current parent adapters. Retained owned events support removed historical parents separately. */
export async function hasHistoryParent(ctx:ControlTx,type:string,id:string):Promise<boolean>{
 const company=ctx.principal.companyId;
 const rows=await ctx.sql`SELECT id FROM (
  SELECT id::text FROM suppliers WHERE ${type==='supplier'||type==='beneficiary_supplier'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM customers WHERE ${type==='customer'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM gl_accounts WHERE ${type==='gl_account'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM bank_categorisation_rules WHERE ${type==='bank_categorisation_rule'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM bank_rules WHERE ${type==='bank_rule'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM bank_transactions WHERE ${type==='bank_transaction'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM gl_journal_entries WHERE ${type==='journal_entry'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM supplier_invoices WHERE ${type==='supplier_invoice'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM customer_invoices WHERE ${type==='customer_invoice'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM supplier_payments WHERE ${type==='supplier_payment'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM customer_payments WHERE ${type==='customer_payment'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM credit_notes WHERE ${type==='credit_note'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM payroll_employees WHERE ${type==='employee'||type==='beneficiary_employee'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM payroll_run_headers WHERE ${type==='payroll_run'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT p.id::text FROM payroll_employee_components p JOIN payroll_employees e ON e.id=p.employee_id
   WHERE ${type==='payroll_employee_component'} AND e.company_id=${company}::uuid AND p.id::text=${id}
  UNION ALL SELECT id::text FROM assets WHERE ${type==='asset'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM fiscal_periods WHERE ${type==='fiscal_period'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM companies WHERE ${type==='company'||type==='company_gl_settings'} AND id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_beneficiary_proposals WHERE ${type==='beneficiary_supplier_proposal'||type==='beneficiary_employee_proposal'}
   AND company_id=${company}::uuid AND id::text=${id} AND entity_type=CASE WHEN ${type}='beneficiary_supplier_proposal' THEN 'supplier' ELSE 'employee' END
  UNION ALL SELECT id::text FROM supplier_payment_batches WHERE ${type==='supplier_payment_batch'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM sage_supplier_invoices WHERE ${type==='sage_supplier_invoice'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM purchase_orders WHERE ${type==='purchase_order'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM goods_received_notes WHERE ${type==='goods_received_note'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT fiscal_year::text FROM fiscal_periods WHERE ${type==='fiscal_year'} AND company_id=${company}::uuid AND fiscal_year::text=${id}
  UNION ALL SELECT ${id}::text FROM fiscal_periods WHERE ${type==='vat_period'} AND company_id=${company}::uuid
   AND start_date::text<=${id.split('/')[1]??''} AND end_date::text>=${id.split('/')[0]??''}
 ) owned LIMIT 1`;
 return rows.length===1||await hasHistoryIntentParent(ctx,type,id);
}
