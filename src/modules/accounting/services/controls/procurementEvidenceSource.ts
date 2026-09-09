import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {readProcurementStorageEvidence,type ProcurementStorageDescriptor} from './procurementEvidenceStorage';
interface DocumentRow{id:string;entity_type:ProcurementStorageDescriptor['entityType'];entity_id:string;file_path:string|null;file_size:number|null;mime_type:string|null}
/** An owned cross-link never changes the original document's tenant. */
export async function loadOwnedProcurementEvidence(ctx:ControlTx,id:string,signal?:AbortSignal){
 assertControlTx(ctx);if(!UUID_RE.test(id))throw new Error('Invalid procurement evidence identity');
 await assertEffectivePermission(ctx,'read:invoices');
 const company=ctx.principal.companyId;
 const [row]=await ctx.sql`SELECT d.id,d.entity_type,d.entity_id,d.file_path,d.file_size,d.mime_type
  FROM procurement_documents d WHERE d.id=${id}::uuid AND d.is_active=true AND (
   (d.entity_type='supplier_invoice' AND EXISTS(SELECT 1 FROM sage_supplier_invoices p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='supplier_payment' AND EXISTS(SELECT 1 FROM supplier_payments p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='customer_invoice' AND EXISTS(SELECT 1 FROM customer_invoices p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='customer_payment' AND EXISTS(SELECT 1 FROM customer_payments p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='credit_note' AND EXISTS(SELECT 1 FROM credit_notes p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='purchase_order' AND EXISTS(SELECT 1 FROM purchase_orders p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='goods_receipt_note' AND EXISTS(SELECT 1 FROM goods_received_notes p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='goods_received_note' AND EXISTS(SELECT 1 FROM goods_received_notes p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid)) OR
   (d.entity_type='grn' AND EXISTS(SELECT 1 FROM goods_received_notes p WHERE p.id=d.entity_id AND p.company_id=${company}::uuid))
  ) FOR SHARE OF d` as DocumentRow[];
 if(!row||!row.file_path)return null;
 // Freeze original parent ownership throughout storage retrieval, including READ COMMITTED callers.
 let parent:unknown[];
 switch(row.entity_type){
  case 'supplier_invoice': parent=await ctx.sql`SELECT id FROM sage_supplier_invoices WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'supplier_payment': parent=await ctx.sql`SELECT id FROM supplier_payments WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'customer_invoice': parent=await ctx.sql`SELECT id FROM customer_invoices WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'customer_payment': parent=await ctx.sql`SELECT id FROM customer_payments WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'credit_note': parent=await ctx.sql`SELECT id FROM credit_notes WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'purchase_order': parent=await ctx.sql`SELECT id FROM purchase_orders WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'goods_receipt_note': parent=await ctx.sql`SELECT id FROM goods_received_notes WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'goods_received_note': parent=await ctx.sql`SELECT id FROM goods_received_notes WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  case 'grn': parent=await ctx.sql`SELECT id FROM goods_received_notes WHERE id=${row.entity_id}::uuid AND company_id=${company}::uuid FOR SHARE`;break;
  default:return null;
 }
 if(parent.length!==1)return null;
 const evidence=await readProcurementStorageEvidence({companyId:company,documentId:row.id,entityType:row.entity_type,entityId:row.entity_id,
  path:row.file_path,recordedSize:row.file_size,mediaType:row.mime_type??'application/octet-stream'},signal);
 return evidence?{...evidence,id:row.id,status:'active'}:null;
}
