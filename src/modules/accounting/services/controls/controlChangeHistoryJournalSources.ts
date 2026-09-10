import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {GLEntrySource} from '../../types/gl.types';
/** Additional source domains; the history reader separately requires audit and reports. */
export const JOURNAL_MERGE_SOURCE_PERMISSIONS={
 manual:[],auto_adjustment:[],auto_recurring:[],year_end:[],
 auto_invoice:['read:invoices'],auto_grn:['read:invoices'],auto_credit_note:['read:invoices'],auto_supplier_invoice:['read:invoices'],auto_write_off:['read:invoices'],auto_purchase_order:['read:invoices'],
 auto_payment:['read:bank-tx','read:invoices'],auto_supplier_payment:['read:bank-tx','read:invoices'],auto_batch_payment:['read:bank-tx','read:invoices'],auto_bank_recon:['read:bank-tx','read:invoices'],
 auto_vat_adjustment:['read:vat'],auto_vat_submission:['read:vat'],
 auto_depreciation:['read:assets'],auto_asset_disposal:['read:assets'],auto_asset_expense:['read:assets'],
 auto_payroll:['read:payroll-sensitive'],auto_bank_transfer:['read:bank-tx'],auto_loan_payment:['read:bank-tx'],
 auto_expense_claim:['read:bank-tx','read:invoices'],auto_expense_receipt:['read:bank-tx','read:invoices'],
 auto_gl_import:['read:imports'],auto_migration:['read:imports','read:invoices','read:bank-tx'],
} as const satisfies Record<GLEntrySource,readonly string[]>;
function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Retained journal source metadata unavailable');
 return value as Record<string,unknown>;
}
function identity(value:unknown,expected:string){if(typeof value!=='string'||value.toLowerCase()!==expected.toLowerCase())throw new Error('Retained journal source metadata unavailable');}
/** Authorize both immutable images. Live journal classification is intentionally irrelevant. */
export async function assertJournalMergeHistorySources(ctx:ControlTx,event:{entityType:string;entityId:string;action:string},values:unknown):Promise<void>{
 if(event.entityType!=='journal_entry'||!event.action.startsWith('accounts_merged:'))return;
 assertControlTx(ctx);if(!UUID_RE.test(event.action.slice('accounts_merged:'.length)))throw new Error('Retained merge identity unavailable');
 const retained=object(values),permissions=new Set<string>();
 for(const side of ['before','after']){
  const image=object(retained[side]),header=object(image.header);
  identity(header.id,event.entityId);identity(header.company_id,ctx.principal.companyId);
  if(typeof header.source!=='string'||!Object.hasOwn(JOURNAL_MERGE_SOURCE_PERMISSIONS,header.source))throw new Error('Retained journal source metadata unavailable');
  if(!Array.isArray(image.lines)||!Array.isArray(image.accounts))throw new Error('Retained journal source metadata unavailable');
  const accountIds=new Set<string>();
  for(const item of image.accounts){const account=object(item);identity(account.company_id,ctx.principal.companyId);
   if(typeof account.id!=='string'||!UUID_RE.test(account.id)||accountIds.has(account.id))throw new Error('Retained journal account metadata unavailable');accountIds.add(account.id);}
  for(const item of image.lines){const line=object(item);identity(line.company_id,ctx.principal.companyId);identity(line.journal_entry_id,event.entityId);
   if(typeof line.gl_account_id!=='string'||!accountIds.has(line.gl_account_id))throw new Error('Retained journal account metadata unavailable');}
  for(const permission of JOURNAL_MERGE_SOURCE_PERMISSIONS[header.source as GLEntrySource])permissions.add(permission);
 }
 for(const permission of [...permissions].sort())await assertEffectivePermission(ctx,permission);
}
