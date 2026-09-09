import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {queryThreeWayMatch} from './threeWayMatchQueryService';
import type {calculateCumulativeThreeWayMatch} from './threeWayMatchMath';
export interface ThreeWayMatchItemResult {itemId:string;itemDescription:string;
 lineMatchStatus:'unmatched'|'po_matched'|'grn_matched'|'fully_matched';qtyVariancePct:number;priceVariancePct:number;
 match:ReturnType<typeof calculateCumulativeThreeWayMatch>}
/** Cache writer shares the forensic read calculation; match state never authorizes posting or overrides an exception. */
export async function performThreeWayMatch(companyId:string,invoiceId:string){
 const ctx=requireControlTx();if(ctx.principal.companyId!==companyId)throw new Error('Three-way match tenant mismatch');
 await assertEffectivePermission(ctx,'write:invoices');
 return withSavepoint('three_way_match_cache',async()=>{
  const [invoice]=await ctx.sql`SELECT id FROM supplier_invoices WHERE company_id=${companyId}::uuid AND id=${invoiceId}::uuid FOR UPDATE`;
  if(!invoice)throw new Error('Supplier invoice not found');
  const population=await queryThreeWayMatch(ctx,{invoiceId});
  if(population.over)throw new Error('Three-way population requires a bounded background scan');
  const itemResults:ThreeWayMatchItemResult[]=[];
  for(const result of population.results){
   if(!result.row.item_id)continue;
   const match=result.match??{status:'unmatched' as const,quantityMatch:false,priceMatch:false,grnMatch:false,
    mismatches:[],missing:result.missing,qtyVariancePct:0,priceVariancePct:0};
   const item={itemId:result.row.item_id,itemDescription:result.row.description??'',lineMatchStatus:match.status,
    qtyVariancePct:match.qtyVariancePct,priceVariancePct:match.priceVariancePct,match};
   // Cache columns have NUMERIC(6,2) bounds; refuse overflow rather than persisting a misleading clipped variance.
   if(Math.abs(item.qtyVariancePct)>=10000||Math.abs(item.priceVariancePct)>=10000)throw new Error('Match variance exceeds cache representation');
   await ctx.sql`UPDATE supplier_invoice_items l SET line_match_status=${item.lineMatchStatus},qty_variance_pct=${item.qtyVariancePct},
    price_variance_pct=${item.priceVariancePct},match_computed_at=clock_timestamp() FROM supplier_invoices i
    WHERE i.company_id=${companyId}::uuid AND i.id=l.supplier_invoice_id AND i.id=${invoiceId}::uuid AND l.id=${item.itemId}::uuid`;
   itemResults.push(item);
  }
  const matchStatus=itemResults.length&&itemResults.every(i=>i.lineMatchStatus==='fully_matched')?'fully_matched':
   itemResults.some(i=>i.lineMatchStatus==='po_matched')?'po_matched':itemResults.some(i=>i.lineMatchStatus==='grn_matched')?'grn_matched':'unmatched';
  await ctx.sql`UPDATE supplier_invoices SET match_status=${matchStatus} WHERE company_id=${companyId}::uuid AND id=${invoiceId}::uuid`;
  return{invoiceId,matchStatus,itemResults};
 });
}
