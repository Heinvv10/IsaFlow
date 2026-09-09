import {vi} from 'vitest';
import type {PoolClient} from 'pg';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {performThreeWayMatch} from '@/modules/accounting/services/ap/supplierInvoiceThreeWayMatch';
import type {MatchSourceRow} from '@/modules/accounting/services/ap/threeWayMatchSources';
export const company='aaaaaaaa-0000-4000-8000-000000000001',invoice='bbbbbbbb-0000-4000-8000-000000000002';
const person='cccccccc-0000-4000-8000-000000000003';
export function source(over:Partial<MatchSourceRow>={}):MatchSourceRow{
 return{invoice_id:invoice,item_id:'dddddddd-0000-4000-8000-000000000004',description:'Cable 100m',supplier_owned:true,
 currency:'ZAR',invoice_date:'2026-01-15',invoice_deleted:false,invoice_status:'approved',cached_status:'unmatched',
 po_id:'po',po_item_id:'line',quantity:'10',unit_price:'100',line_total:'1000',flat_po_id:'po',supplier_po_id:null,
 ordered:'10',ordered_price:'100',po_status:'received',version:null,
 bills:[{id:'bill',invoiceId:invoice,quantity:'10',unitPrice:'100',date:'2026-01-15',status:'approved'}],
 receipts:[{id:'grn',lineId:'received-line',received:'10',rejected:'0',status:'accepted',quality:'accepted',date:'2026-01-15'}],
 rules:[{id:'rule',qty:'2',price:'2',updatedAt:'2026-01-01'}],...over};
}
/** Synthetic pg boundary only; context, permissions, SQL builder and matching are real. */
export function fixture(rows:MatchSourceRow[]=[source()]){
 const state={rows,exists:true,role:'admin',failUpdate:false};
 const query=vi.fn(async(text:string,values?:unknown[])=>{
  let result:unknown[]=[];
  if(text.includes('control_lock_permission_principal'))result=[{role:state.role,is_active:true,status:'active'}];
  else if(text.includes('FROM company_user_permissions'))result=[];
  else if(text.includes('SELECT id FROM supplier_invoices'))result=state.exists?[{id:invoice}]:[];
  else if(text.includes('SELECT i.id AS invoice_id'))result=state.rows.map(row=>({...row,population_count:state.rows.length}));
  else if(text.includes('UPDATE supplier_invoice_items')&&state.failUpdate)throw new Error('Synthetic cache storage failure');
  else if(!/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(text)&&!text.includes('UPDATE supplier_invoice'))throw new Error('Unexpected fixture query: '+text);
  return{rows:result,rowCount:result.length,command:'SELECT',fields:[],values};
 });
 const client={query} as unknown as PoolClient;
 const run=()=>withControlRequest({client,userId:person,companyId:company,claims:{}},{personId:person,companyId:company,authMethod:'cookie'},()=>performThreeWayMatch(company,invoice));
 const updates=()=>query.mock.calls.filter(([text])=>text.includes('UPDATE supplier_invoice'));
 return{state,query,run,updates};
}
