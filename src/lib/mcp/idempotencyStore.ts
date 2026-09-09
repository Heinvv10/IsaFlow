import {sql} from '@/lib/neon';

/** Financial replay protection has no audit-retention expiry; write in the effect transaction. */
export async function storeIdempotentResult(companyId:string,tool:string,key:string,argsHash:string,result:unknown):Promise<void>{
  const rows=await sql`
    INSERT INTO mcp_idempotency_results(company_id,tool,idempotency_key,args_hash,result)
    VALUES(${companyId}::uuid,${tool},${key},${argsHash},${JSON.stringify(result??null)}::jsonb)
    ON CONFLICT(company_id,tool,idempotency_key) DO NOTHING RETURNING args_hash
  `;
  if(rows.length===0){
    // A concurrent/incorrect internal writer must never silently occupy a different intent's key.
    const existing=await sql`SELECT args_hash FROM mcp_idempotency_results
      WHERE company_id=${companyId}::uuid AND tool=${tool} AND idempotency_key=${key}`;
    if(existing.length!==1||existing[0]!.args_hash!==argsHash)throw new Error('Idempotency receipt conflict');
  }
}
