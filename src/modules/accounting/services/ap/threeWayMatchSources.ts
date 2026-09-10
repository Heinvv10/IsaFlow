import type {ControlTx} from '../controls/contracts';
import {RISK_SOURCE_LIMIT} from '../controls/invoiceRiskQueriesResult';
export interface MatchSourceRow {invoice_id:string;item_id:string|null;description:string|null;supplier_owned:boolean;currency:string;invoice_date:string;
 invoice_deleted:boolean;invoice_status:string;cached_status:string;po_id:string|null;po_item_id:string|null;quantity:string|null;unit_price:string|null;line_total:string|null;
 flat_po_id:string|null;supplier_po_id:string|null;ordered:string|null;ordered_price:string|null;po_status:string|null;
 bills:Array<{id:string;invoiceId:string;quantity:string;unitPrice:string;date:string;status:string}>;
 receipts:Array<{id:string;lineId:string;received:string;rejected:string;status:string;quality:string;date:string}>;
 rules:Array<{id:string;qty:string;price:string;updatedAt:string}>;version:number|string|null}
export async function readThreeWayMatchSources(ctx:ControlTx,cutoff:string|null,invoiceId:string|null){
 const rows=await ctx.sql`SELECT i.id AS invoice_id,l.id AS item_id,l.description,(s.id IS NOT NULL) AS supplier_owned,i.currency,i.invoice_date::text,
 i.deleted_at IS NOT NULL AS invoice_deleted,i.status AS invoice_status,i.match_status AS cached_status,i.purchase_order_id AS po_id,l.po_item_id,l.quantity::text,l.unit_price::text,l.line_total::text,
 p.id AS flat_po_id,sp.id AS supplier_po_id,COALESCE(pi.quantity,spi.quantity)::text AS ordered,
 COALESCE(pi.unit_price,spi.unit_price)::text AS ordered_price,COALESCE(p.status,sp.status) AS po_status,
 COALESCE(b.bills,'[]'::jsonb) AS bills,COALESCE(g.receipts,'[]'::jsonb) AS receipts,COALESCE(r.rules,'[]'::jsonb) AS rules,v.version,
 count(*) OVER()::int AS population_count
 FROM supplier_invoices i LEFT JOIN supplier_invoice_items l ON l.supplier_invoice_id=i.id
 LEFT JOIN suppliers s ON s.company_id=i.company_id AND s.id=i.supplier_id
 LEFT JOIN purchase_orders p ON p.company_id=i.company_id AND p.id=i.purchase_order_id AND p.supplier_id=i.supplier_id
 LEFT JOIN po_items pi ON pi.purchase_order_id=p.id AND pi.id=l.po_item_id
 LEFT JOIN supplier_purchase_orders sp ON sp.company_id=i.company_id AND sp.id=i.purchase_order_id AND sp.supplier_id=i.supplier_id
 LEFT JOIN supplier_purchase_order_items spi ON spi.purchase_order_id=sp.id AND spi.id=l.po_item_id
 LEFT JOIN LATERAL(SELECT cv.* FROM control_entity_versions cv WHERE cv.company_id=i.company_id AND cv.entity_type='supplier_invoice' AND cv.entity_id_canonical=i.id::text ORDER BY cv.version DESC,(cv.entity_id=i.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
 LEFT JOIN LATERAL (SELECT jsonb_agg(x.facts ORDER BY x.id) AS bills FROM (
  SELECT bl.id,jsonb_build_object('id',bl.id,'invoiceId',bi.id,'quantity',bl.quantity::text,
   'unitPrice',bl.unit_price::text,'date',bi.invoice_date::text,'status',bi.status) AS facts
  FROM supplier_invoice_items bl JOIN supplier_invoices bi ON bi.id=bl.supplier_invoice_id AND bi.company_id=i.company_id
  WHERE bi.supplier_id=i.supplier_id AND bi.purchase_order_id=i.purchase_order_id AND bl.po_item_id=l.po_item_id
   AND bi.status NOT IN ('cancelled','void','voided','rejected') AND bi.deleted_at IS NULL
   AND (${cutoff}::date IS NULL OR bi.invoice_date<=${cutoff}::date) ORDER BY bl.id LIMIT 101) x) b ON true
 LEFT JOIN LATERAL (SELECT jsonb_agg(x.facts ORDER BY x.id) AS receipts FROM (
  SELECT gl.id,jsonb_build_object('id',gn.id,'lineId',gl.id,'received',gl.quantity_received::text,
   'rejected',gl.quantity_rejected::text,'status',gn.status,'quality',gl.quality_status,'date',gn.received_date::text) AS facts
  FROM goods_received_notes gn JOIN grn_items gl ON gl.grn_id=gn.id
  WHERE gn.company_id=i.company_id AND gn.purchase_order_id=p.id AND gl.po_item_id=pi.id
   AND (${cutoff}::date IS NULL OR gn.received_date<=${cutoff}::date) ORDER BY gl.id LIMIT 101) x) g ON true
 LEFT JOIN LATERAL (SELECT jsonb_agg(x.facts ORDER BY x.id) AS rules FROM (
  SELECT cr.id,jsonb_build_object('id',cr.id,'qty',cr.qty_tolerance_pct::text,'price',cr.price_tolerance_pct::text,'updatedAt',cr.updated_at::text) AS facts
  FROM supplier_coding_rules cr WHERE cr.company_id=i.company_id AND cr.supplier_id=i.supplier_id ORDER BY cr.id LIMIT 101) x) r ON true
 WHERE i.company_id=${ctx.principal.companyId}::uuid AND i.purchase_order_id IS NOT NULL
  AND (${invoiceId}::uuid IS NULL OR i.id=${invoiceId}::uuid) AND (${cutoff}::date IS NULL OR i.invoice_date<=${cutoff}::date)
 ORDER BY i.id,l.id LIMIT ${RISK_SOURCE_LIMIT+1}` as Array<MatchSourceRow&{population_count:number}>;
 return{rows:rows.map(({population_count:_count,...row})=>row),populationCount:rows[0]?.population_count??0};
}
