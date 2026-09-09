import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from '../controls/context';
import type {ControlTx} from '../controls/contracts';
import {riskHash,riskOptions,RISK_SOURCE_LIMIT} from '../controls/invoiceRiskQueriesResult';
import {readThreeWayMatchSources,type MatchSourceRow} from './threeWayMatchSources';
import {calculateCumulativeThreeWayMatch} from './threeWayMatchMath';
export function evaluateThreeWayMatchRow(row:MatchSourceRow){
 const missing:string[]=[];
 const excluded=row.invoice_deleted||['cancelled','void','voided','rejected'].includes(row.invoice_status);
 if(!row.supplier_owned||!row.item_id||!row.ordered||!row.ordered_price||!row.unit_price||!row.quantity||!!row.flat_po_id===!!row.supplier_po_id)
  missing.push('owned_purchase_order_line_material_unavailable');
 if(row.po_status&&['draft','cancelled'].includes(row.po_status))missing.push('eligible_purchase_order_unavailable');
 const rules=new Map(row.rules.map(rule=>[`${rule.qty}/${rule.price}`,rule]));
 if(rules.size>1)missing.push('ambiguous_supplier_match_tolerances');
 const rule=row.rules[0],tolerance={qty:rule?.qty??'2',price:rule?.price??'2',source:rule?'supplier_coding_rules':'default_2_percent'};
 const known=row.receipts.filter(r=>['received','inspected','accepted','rejected'].includes(r.status));
 // quantity_received is already accepted by the current receiving writer; rejected is separately recorded.
 const accepted=known.length?known.map(r=>r.status==='rejected'||r.quality==='rejected'||r.quality==='pending'?'0':r.received):null;
 const match=missing.length||excluded?null:calculateCumulativeThreeWayMatch({ordered:row.ordered!,unitPrice:row.ordered_price!,
  accepted:row.supplier_po_id?null:accepted,invoiced:row.bills.map(b=>b.quantity),invoiceUnitPrice:row.unit_price!,qtyTolerance:tolerance.qty,priceTolerance:tolerance.price});
 if(row.receipts.some(r=>!['received','inspected','accepted','rejected'].includes(r.status)||!['accepted','partial','rejected'].includes(r.quality)))missing.push('unresolved_receipt_acceptance_evidence');
 if(row.supplier_po_id)missing.push('supplier_po_accepted_receipt_provenance_unavailable');
 if(match)missing.push(...match.missing);
 return{row,match,missing,excluded,tolerance,fingerprint:riskHash(row)};
}
export async function queryThreeWayMatch(ctx:ControlTx,options:{cutoff?:string;invoiceId?:string}={}){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:invoices');
 if(options.invoiceId!==undefined&&!UUID_RE.test(options.invoiceId))throw new Error('Invalid supplier invoice');
 const cutoff=riskOptions(options.cutoff?{cutoff:options.cutoff}:{}).cutoff;
 const population=await readThreeWayMatchSources(ctx,cutoff,options.invoiceId??null);
 const complexity=population.rows.reduce((sum,row)=>sum+row.bills.length+row.receipts.length+row.rules.length,0);
 const over=population.populationCount>RISK_SOURCE_LIMIT||complexity>RISK_SOURCE_LIMIT||population.rows.some(r=>r.bills.length>100||r.receipts.length>100||r.rules.length>100);
 return{populationCount:population.populationCount,over,results:over?[]:population.rows.map(evaluateThreeWayMatchRow),
  materialFingerprint:riskHash({company:ctx.principal.companyId,cutoff,rows:population.rows.map(({cached_status:_cache,...row})=>row),populationCount:population.populationCount}),
  fingerprint:riskHash({company:ctx.principal.companyId,cutoff,rows:population.rows,populationCount:population.populationCount})};
}
