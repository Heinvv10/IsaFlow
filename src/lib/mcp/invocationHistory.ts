import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {captureInvocationIdentity,persistInvocationOutcome,verifyInvocationOutcome} from './invocationPersistence';
import {InvocationStoreError,type InvocationSummary} from './invocationTypes';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface HistoryRow {id:string;tool:string;admitted_at:Date|string;person_id:string;transaction_outcome:InvocationSummary['transactionOutcome']|null;
 status:InvocationSummary['status'];reported_write:boolean|null;reason_code:string|null;duration_ms:number|null;recorded_at:Date|string|null}
function summary(row:HistoryRow):InvocationSummary{return{attemptId:row.id,tool:row.tool,admittedAt:new Date(row.admitted_at).toISOString(),personId:row.person_id,
 transactionOutcome:row.transaction_outcome??'unknown',status:row.status,reportedWrite:row.reported_write,reasonCode:row.reason_code,durationMs:row.duration_ms,
 settledAt:row.recorded_at?new Date(row.recorded_at).toISOString():null};}
/** No result bodies, raw arguments, grant identifiers or key hashes are exposed. Reads never reconcile. */
export async function getMcpInvocationStatus(ctx:ControlTx,attemptId:string):Promise<InvocationSummary|null>{
 await assertEffectivePermission(ctx,'read:audit');if(!UUID.test(attemptId))throw new InvocationStoreError();
 const rows=await ctx.sql`SELECT a.id,a.tool,a.admitted_at,a.person_id,o.transaction_outcome,o.status,o.reported_write,o.reason_code,o.duration_ms,o.recorded_at
 FROM mcp_invocation_attempts a LEFT JOIN LATERAL(SELECT * FROM mcp_invocation_outcomes o
 WHERE o.company_id=a.company_id AND o.attempt_id=a.id
 ORDER BY (o.transaction_outcome<>'unknown') DESC,o.recorded_at DESC,o.id DESC LIMIT 1)o ON true
 WHERE a.company_id=${ctx.principal.companyId}::uuid AND a.id=${attemptId}::uuid` as HistoryRow[];
 return rows[0]?summary(rows[0]):null;
}
/** UUID keyset avoids timestamp truncation; each page is bounded and tenant-scoped. */
export async function listMcpInvocations(ctx:ControlTx,input:{afterId?:string;limit?:number}={}):Promise<{items:InvocationSummary[];nextAfterId:string|null}>{
 await assertEffectivePermission(ctx,'read:audit');const limit=input.limit??50;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||(input.afterId!==undefined&&!UUID.test(input.afterId)))throw new InvocationStoreError();
 const rows=await ctx.sql`SELECT a.id,a.tool,a.admitted_at,a.person_id,o.transaction_outcome,o.status,o.reported_write,o.reason_code,o.duration_ms,o.recorded_at
 FROM mcp_invocation_attempts a LEFT JOIN LATERAL(SELECT * FROM mcp_invocation_outcomes o
 WHERE o.company_id=a.company_id AND o.attempt_id=a.id
 ORDER BY (o.transaction_outcome<>'unknown') DESC,o.recorded_at DESC,o.id DESC LIMIT 1)o ON true
 WHERE a.company_id=${ctx.principal.companyId}::uuid AND (${input.afterId??null}::uuid IS NULL OR a.id>${input.afterId??null}::uuid)
 ORDER BY a.id LIMIT ${limit+1}` as HistoryRow[];
 return{items:rows.slice(0,limit).map(summary),nextAfterId:rows.length>limit?rows[limit-1]!.id:null};
}
/** Explicit mutation: missing finalizers remain unknown until PostgreSQL proves the original transaction outcome. */
export async function reconcileMcpInvocation(ctx:ControlTx,attemptId:string):Promise<InvocationSummary|null>{
 await assertEffectivePermission(ctx,'write:audit');
 const existing=await getMcpInvocationStatus(ctx,attemptId);if(!existing)return null;
 const snapshot=captureInvocationIdentity(ctx),proof=await verifyInvocationOutcome(snapshot,attemptId);
 await persistInvocationOutcome(snapshot,attemptId,proof.outcome,proof.completion,'reconciled');
 return getMcpInvocationStatus(ctx,attemptId);
}
