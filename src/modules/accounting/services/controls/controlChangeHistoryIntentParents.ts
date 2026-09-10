import type {ControlTx} from './contracts';
/** Separate adapters keep control intent ownership distinct from mutable economic parent rows. */
export async function hasHistoryIntentParent(ctx:ControlTx,type:string,id:string){
 const company=ctx.principal.companyId;
 const rows=await ctx.sql`SELECT id FROM (
  SELECT id::text FROM control_bank_allocation_intents WHERE ${type==='bank_allocation_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_bank_allocation_reversal_intents WHERE ${type==='bank_allocation_reversal_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_cash_application_intents WHERE ${type==='cash_application_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_cash_application_reversal_intents WHERE ${type==='cash_application_reversal_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_bank_transfer_intents WHERE ${type==='bank_transfer_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_lockdown_intents WHERE ${type==='company_lockdown_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_asset_depreciation_intents WHERE ${type==='asset_depreciation_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_invoice_match_override_intents WHERE ${type==='invoice_match_override_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_payment_preparations WHERE ${type==='payment_preparation'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_payment_release_intents WHERE ${type==='payment_release_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_bank_statement_attestation_intents WHERE ${type==='bank_statement_attestation_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_payroll_compensation_intents WHERE ${type==='payroll_compensation_intent'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_employee_beneficiary_evidence WHERE ${type==='employee_beneficiary_evidence'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_historical_imports WHERE ${type==='historical_import'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_historical_import_sources WHERE ${type==='historical_import_source'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_credit_note_applications WHERE ${type==='credit_note_application'} AND company_id=${company}::uuid AND id::text=${id}
  UNION ALL SELECT id::text FROM control_recurring_invoice_runs WHERE ${type==='recurring_invoice_run'} AND company_id=${company}::uuid AND id::text=${id}
 ) owned LIMIT 1`;
 return rows.length===1;
}
