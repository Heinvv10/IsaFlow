import { createHash } from 'node:crypto';
import { UUID_RE } from '@/lib/validation';
import { resolveEffectivePermissions } from '@/lib/auth/effectivePermissions';
import { assertControlTx } from './context';
import { canonicalJson } from './canonical';
import type { ControlTx } from './contracts';
import { loadEvidenceNode,listEvidenceNeighbors } from './transactionEvidenceQueries';
import { EVIDENCE_TYPES,evidenceKey,readPermission,type EvidenceIdentity,type EvidenceNode,type EvidenceEdge,
  type CoverageGap,type TransactionEvidenceResult } from './transactionEvidenceTypes';
export type { TransactionEvidenceResult,EvidenceNode,EvidenceEdge } from './transactionEvidenceTypes';
export class TransactionEvidenceError extends Error {
  constructor(public readonly code: 'EVIDENCE_UNAVAILABLE'|'INVALID_EVIDENCE_CURSOR'|'INVALID_EVIDENCE_REQUEST') {
    super(code==='EVIDENCE_UNAVAILABLE'?'Evidence unavailable':code==='INVALID_EVIDENCE_CURSOR'?'Invalid or stale evidence cursor':'Invalid evidence request');
  }
}
const order = (a:string,b:string) => a<b?-1:a>b?1:0;
/** Traverses only recorded relationships; completeness describes this bounded current graph, not historical assurance. */
export async function inspectTransactionEvidence(ctx: ControlTx,input:{entityType:string;entityId:string;cursor?:string;limit?:number}):Promise<TransactionEvidenceResult> {
  assertControlTx(ctx);
  if (!EVIDENCE_TYPES.includes(input.entityType as EvidenceIdentity['entityType']) || !UUID_RE.test(input.entityId)
    || !Number.isInteger(input.limit??50) || (input.limit??50)<1 || (input.limit??50)>100) throw new TransactionEvidenceError('INVALID_EVIDENCE_REQUEST');
  const root:EvidenceIdentity={entityType:input.entityType as EvidenceIdentity['entityType'],entityId:input.entityId.toLowerCase()};
  let permissions:Set<string>;
  try { permissions=new Set((await resolveEffectivePermissions(ctx)).permissions); }
  catch { throw new TransactionEvidenceError('EVIDENCE_UNAVAILABLE'); }
  if(!permissions.has(readPermission(root.entityType)))throw new TransactionEvidenceError('EVIDENCE_UNAVAILABLE');
  const nodes=new Map<string,EvidenceNode>(),edges=new Map<string,EvidenceEdge>(),gaps=new Map<string,CoverageGap>();
  const unavailable=new Set<string>(),queue:Array<{ref:EvidenceIdentity;depth:number}>=[];
  let partial=false,queries=0;
  const gap=(source:EvidenceIdentity,reason:string,incomplete=false)=>{gaps.set(`${evidenceKey(source)}:${reason}`,{source:{entityType:source.entityType,entityId:source.entityId},reason});if(incomplete)partial=true;};
  async function node(ref:EvidenceIdentity):Promise<EvidenceNode|null>{
    if(!EVIDENCE_TYPES.includes(ref.entityType)||!UUID_RE.test(ref.entityId))return null;
    const key=evidenceKey(ref);
    if(nodes.has(key))return nodes.get(key)!;
    if(unavailable.has(key)||!permissions.has(readPermission(ref.entityType)))return null;
    if(++queries>2000){gap(root,'TRAVERSAL_READ_BUDGET',true);return null;}
    const value=await loadEvidenceNode(ctx,ref,permissions);
    if(value)nodes.set(key,value);else unavailable.add(key);
    return value;
  }
  if(!await node(root))throw new TransactionEvidenceError('EVIDENCE_UNAVAILABLE');
  queue.push({ref:root,depth:0});
  const expanded=new Set<string>();
  while(queue.length){
    const {ref,depth}=queue.shift()!,key=evidenceKey(ref);
    if(expanded.has(key))continue;
    expanded.add(key);
    if(ref.entityType==='supplier_invoice')gap(ref,'NATIVE_PROCUREMENT_PARENT_UNSUPPORTED',true);
    if(depth===6){gap(ref,'DEPTH_BUDGET',true);continue;}
    let offset=0,total=1;
    while(offset<total){
      if(++queries>2000){gap(root,'TRAVERSAL_READ_BUDGET',true);queue.length=0;break;}
      const page=await listEvidenceNeighbors(ctx,ref,offset,100);total=page.total;
      if(!Number.isSafeInteger(total)||total<0||page.links.length>100)throw new TransactionEvidenceError('EVIDENCE_UNAVAILABLE');
      if(!page.links.length&&offset<total){gap(ref,'RELATION_POPULATION_CHANGED',true);break;}
      for(const link of page.links){
        if(link.gap){gap(ref,link.gap,true);continue;}
        const target=link.target,targetKey=evidenceKey(target);
        if(!nodes.has(targetKey)&&nodes.size>=500){gap(ref,'NODE_BUDGET',true);continue;}
        const found=await node(target);
        if(!found){gap(ref,'MISSING_OR_INACCESSIBLE_LINK',true);continue;}
        const ends=[ref,target].sort((a,b)=>order(evidenceKey(a),evidenceKey(b)));
        const edgeKey=`${evidenceKey(ends[0]!)}|${link.relation}|${evidenceKey(ends[1]!)}`;
        if(!edges.has(edgeKey)&&edges.size>=2000){gap(ref,'EDGE_BUDGET',true);queue.length=0;break;}
        edges.set(edgeKey,{from:ends[0]!,to:ends[1]!,relation:link.relation,provenance:'recorded'});
        if(!expanded.has(targetKey))queue.push({ref:target,depth:depth+1});
      }
      offset+=page.links.length;
      if(nodes.size>=500&&offset<total){gap(ref,'NODE_BUDGET',true);break;}
      if(edges.size>=2000)break;
    }
  }
  const allNodes=[...nodes.values()].sort((a,b)=>order(evidenceKey(a),evidenceKey(b)));
  const allEdges=[...edges.entries()].sort(([a],[b])=>order(a,b)).map(([,v])=>v);
  const documentCounts={captured:0,procurement:0,bank_attachment:0};
  for(const n of allNodes){
    if(n.entityType==='captured_document')documentCounts.captured++;
    if(n.entityType==='procurement_document')documentCounts.procurement++;
    if(n.entityType==='bank_attachment')documentCounts.bank_attachment++;
    if(n.flags.includes('untracked'))gap(n,'HISTORICAL_VERSION_UNTRACKED');
    if(n.flags.includes('ambiguous'))gap(n,'AMBIGUOUS_RECORDED_PARENT',true);
    // A fork is reported, never hidden; a fork with no lineage to follow is also an incomplete answer.
    if(n.flags.includes('forked'))gap(n,n.version===null?'CONTROL_LINEAGE_AMBIGUOUS':'CONTROL_LINEAGE_FORKED',n.version===null);
    if(n.hashAvailability==='missing')gap(n,'DOCUMENT_HASH_OR_BYTES_UNAVAILABLE');
  }
  if(Object.values(documentCounts).every(n=>n===0))gap(root,'NO_DOCUMENT_IN_VISITED_GRAPH');
  const recorded=allNodes.flatMap(n=>n.recordedSince?[n.recordedSince]:[]).sort();
  const coverage:TransactionEvidenceResult['coverage']={status:partial?'partial':'complete',countScope:'visited_population',
    visitedNodes:allNodes.length,discoveredEdges:allEdges.length,documentCounts,historicalCoverage:recorded.length?'recorded_since':'untracked',
    earliestRecordedEvent:recorded[0]??null,gaps:[...gaps.entries()].sort(([a],[b])=>order(a,b)).map(([,v])=>v),maxDepth:6,maxNodes:500};
  const digest=createHash('sha256').update(canonicalJson({nodes:allNodes,edges:allEdges,coverage})).digest('hex');
  let offset=0;
  if(input.cursor){
    try{
      if(input.cursor.length>2048)throw new Error('length');
      const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')) as Record<string,unknown>;
      if(c.companyId!==ctx.principal.companyId||c.root!==evidenceKey(root)||c.digest!==digest||!Number.isSafeInteger(c.offset)||Number(c.offset)<0
        ||Number(c.offset)>=Math.max(allNodes.length,allEdges.length))throw new Error('binding');
      offset=Number(c.offset);
    }catch{throw new TransactionEvidenceError('INVALID_EVIDENCE_CURSOR');}
  }
  const limit=input.limit??50,next=offset+limit;
  const nextCursor=next<Math.max(allNodes.length,allEdges.length)
    ?Buffer.from(JSON.stringify({companyId:ctx.principal.companyId,root:evidenceKey(root),digest,offset:next})).toString('base64url'):null;
  return{root,nodes:allNodes.slice(offset,next),edges:allEdges.slice(offset,next),coverage,nextCursor};
}
