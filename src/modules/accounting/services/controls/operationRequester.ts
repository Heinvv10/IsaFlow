import type {ControlTx,OperationRef} from './contracts';
import {assertControlTx} from './context';
/** Immutable preparation identity cannot be replaced by a proxy approval requester. */
export async function assertOperationRequester(ctx:ControlTx,ref:OperationRef,requesterPersonId:string):Promise<void>{
 assertControlTx(ctx);let rows:unknown[];
 if(ref.entityType==='bank_allocation_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_bank_allocation_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='bank_allocation_reversal_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_bank_allocation_reversal_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='cash_application_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_cash_application_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='cash_application_reversal_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_cash_application_reversal_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='payroll_compensation_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_payroll_compensation_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='bank_statement_attestation_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_bank_statement_attestation_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='bank_transfer_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_bank_transfer_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='asset_depreciation_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_asset_depreciation_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='company_lockdown_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_lockdown_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='payment_release_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_payment_release_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='historical_import')rows=await ctx.sql`SELECT requester_person_id FROM control_historical_imports
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else if(ref.entityType==='invoice_match_override_intent')rows=await ctx.sql`SELECT requester_person_id FROM control_invoice_match_override_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
 else return;
 const row=rows[0] as {requester_person_id:string}|undefined;
 if(rows.length!==1||!row||row.requester_person_id!==requesterPersonId)throw new Error('Original intent requester must request approval');
}
