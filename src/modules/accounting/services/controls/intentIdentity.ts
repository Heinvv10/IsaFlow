import {UUID_RE} from '@/lib/validation';
import type {ControlTx} from './contracts';
/** A controlled intent UUID has one spelling: validated, then lowercased. */
export function canonicalIntentId(value:unknown):string{
 if(typeof value!=='string'||!UUID_RE.test(value))throw new Error('Invalid controlled intent UUID');
 return value.toLowerCase();
}
/** Legacy receipts may spell the result identity in any case. */
export function sameIntentId(value:unknown,intentId:string):boolean{
 return typeof value==='string'&&UUID_RE.test(value)&&value.toLowerCase()===canonicalIntentId(intentId);
}
/** Receipts written before canonicalization keep their original entity_id spelling; two spellings of one intent fail closed. */
export async function loadIntentReceipt<R>(ctx:ControlTx,ref:{entityType:string;entityId:string;operation:string}):Promise<{id:string;result:R}|undefined>{
 const rows=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
  AND operation=${ref.operation} AND entity_type=${ref.entityType} AND lower(entity_id)=${canonicalIntentId(ref.entityId)} LIMIT 2` as {id:string;result:R}[];
 if(rows.length>1)throw new Error('Ambiguous operation receipt');
 return rows[0];
}
