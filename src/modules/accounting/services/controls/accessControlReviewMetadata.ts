import {sql} from '@/lib/neon';
import {getAccessReviewPool} from './accessControlReviewPool';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {AccessReviewInput} from './accessControlReviewInput';
import type {AccessSubject} from './accessControlReviewPolicy';
import {accessReviewQuery} from './accessControlReviewQueries';
interface MetadataRow {total:string;evaluated_at:Date|string;subject:AccessSubject|null;oversized:boolean}
/** Private server boundary: caller authority stays locked in the original transaction. */
export async function readAccessReviewMetadata(ctx:ControlTx,input:AccessReviewInput){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:access');
 const client=await getAccessReviewPool().connect();let begun=false,broken=false;
 const execute=(query:{text:string;values:unknown[]})=>client.query(query.text,query.values);
 try{
  await execute(sql`BEGIN READ ONLY`);begun=true;
  // Fail rather than silently count owner-only RLS subsets under a restricted DB login.
  await execute(sql`SET LOCAL row_security=off`);
  await execute(sql`SET LOCAL statement_timeout='10s'`);
  const result=await execute(accessReviewQuery(ctx.principal.companyId,input));
  const rows=result.rows as MetadataRow[];
  if(!rows.length||rows.some(row=>row.oversized)||Buffer.byteLength(JSON.stringify(rows))>2*1024*1024)throw new Error('Complete access metadata exceeds the bounded page limit');
  const total=Number(rows[0]!.total);if(!Number.isSafeInteger(total)||total<0)throw new Error('Invalid access review census');
  assertControlTx(ctx);await execute(sql`ROLLBACK`);begun=false;
  return{populationTotal:total,evaluatedAt:new Date(rows[0]!.evaluated_at).toISOString(),subjects:rows.flatMap(row=>row.subject?[row.subject]:[])};
 }catch(error){
  if(begun){try{await execute(sql`ROLLBACK`);}catch(rollbackError){broken=true;throw new AggregateError([error,rollbackError],'Access metadata rollback failed');}}
  throw error;
 }finally{client.release(broken);}
}
