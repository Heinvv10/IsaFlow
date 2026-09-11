import {UUID_RE} from '@/lib/validation';
import type {ControlTx} from './contracts';
/** A controlled intent UUID has one spelling: validated, then lowercased. */
export function canonicalIntentId(value:unknown):string{
 if(typeof value!=='string'||!UUID_RE.test(value))throw new Error('Invalid controlled intent UUID');
 return value.toLowerCase();
}
/**
 * `uuid::text` spells a uuid exactly this way, so `i.id::text=c` holds only when c matches it and `c::uuid=i.id`. Stated
 * as `i.id=CASE WHEN c ~ CANONICAL_UUID_TEXT THEN c::uuid END` beside that comparison inside a LATERAL, where c is a
 * Param, it reaches the intent by primary key: under RLS a cast of another relation's column is never an index condition.
 */
export const CANONICAL_UUID_TEXT='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/** Legacy receipts may spell the result identity in any case. */
export function sameIntentId(value:unknown,intentId:string):boolean{
 return typeof value==='string'&&UUID_RE.test(value)&&value.toLowerCase()===canonicalIntentId(intentId);
}
/** Receipts written before canonicalization keep their original entity_id spelling; two spellings of one intent fail closed. */
export async function loadIntentReceipt<R>(ctx:ControlTx,ref:{entityType:string;entityId:string;operation:string}):Promise<{id:string;result:R}|undefined>{
 const rows=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
  AND operation=${ref.operation} AND entity_type=${ref.entityType} AND entity_id_canonical=${canonicalIntentId(ref.entityId)} LIMIT 2` as {id:string;result:R}[];
 if(rows.length>1)throw new Error('Ambiguous operation receipt');
 return rows[0];
}
