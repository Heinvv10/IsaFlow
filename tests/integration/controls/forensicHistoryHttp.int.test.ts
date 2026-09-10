import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {operationalCheckHttpFixture} from './operationalCheckHttpFixture';
import type {RpcReply} from '../mcp-http/client';
let f:Awaited<ReturnType<typeof operationalCheckHttpFixture>>,ruleId:string;
beforeAll(async()=>{f=await operationalCheckHttpFixture();},30000);afterAll(async()=>{if(f)await f.close();});
function dto<T>(reply:RpcReply):T{expect(reply.result?.isError).not.toBe(true);return JSON.parse(reply.result!.content!.map(row=>row.text).join('\n')) as T;}
const history=(args:Record<string,unknown>={})=>f.call('entity_change_history',{entity_type:'bank_categorisation_rule',entity_id:ruleId,...args});
type Page={available:boolean;items:Array<{newVersion:number;actor:{personId:string;connectionId:string};before:Record<string,unknown>|null;after:Record<string,unknown>|null}>;nextCursor:string|null;coverage:{eventCount:number}};
it('reads exact actual MCP-produced rule history and signed continuation from the default registry',async()=>{
 const created=dto<{id:string}>(await f.call('create_bank_rule',{rule_name:'Synthetic history HTTP',match_field:'description',match_type:'contains',match_pattern:'HISTORY_HTTP',gl_account_id:f.from,idempotency_key:randomUUID()}));ruleId=created.id;
 await f.call('update_bank_rule',{rule_id:ruleId,priority:0,idempotency_key:randomUUID()});
 const first=dto<Page>(await history({limit:1}));expect(first.available).toBe(true);expect(first.coverage.eventCount).toBe(2);expect(first.items).toHaveLength(1);
 expect(first.items[0]).toMatchObject({newVersion:1,before:null,after:{match_pattern:'HISTORY_HTTP',priority:100},actor:{personId:f.f.u1.id,connectionId:f.f.u1.tokens[0]!.id}});
 const last=dto<Page>(await history({limit:1,cursor:first.nextCursor}));expect(last.items).toHaveLength(1);expect(last.items[0]).toMatchObject({newVersion:2,after:{priority:0}});
 expect(last.items[0]?.before).toEqual(first.items[0]?.after);expect(last.nextCursor).toBeNull();
 expect((await history({cursor:first.nextCursor+'x'})).result?.isError).toBe(true);
});
it('returns sanitized live invocation outcomes and bounded UUID pagination without hiding unknown calls',async()=>{
 type Calls={items:Array<{attemptId:string;tool:string;transactionOutcome:string;reportedWrite:boolean|null}>;nextAfterId:string|null};
 const all=dto<Calls>(await f.call('mcp_call_history',{limit:100}));
 expect(all.items).toEqual(expect.arrayContaining([expect.objectContaining({tool:'create_bank_rule',transactionOutcome:'committed',reportedWrite:true}),expect.objectContaining({tool:'update_bank_rule',transactionOutcome:'committed',reportedWrite:true})]));
 expect(all.items.some(row=>row.transactionOutcome==='unknown')).toBe(true);
 expect(JSON.stringify(all)).not.toContain(f.f.u1.tokens[0]!.raw);expect(JSON.stringify(all)).not.toMatch(/token_hash|idempotency_key|HISTORY_HTTP/);
 const first=dto<Calls>(await f.call('mcp_call_history',{limit:1})),next=dto<Calls>(await f.call('mcp_call_history',{limit:1,after_id:first.nextAfterId}));
 expect(first.items).toHaveLength(1);expect(next.items).toHaveLength(1);expect(next.items[0]!.attemptId>first.items[0]!.attemptId).toBe(true);
});
it('uses shared graph ownership and current domain/audit authority with no invented document evidence',async()=>{
 const bank=await f.bank(),args={entity_type:'bank_transaction',entity_id:bank};
 const graph=dto<{nodes:Array<{entityType:string;entityId:string}>;coverage:{countScope:string;gaps:Array<{reason:string}>}}>(await f.call('transaction_evidence_chain',args));
 expect(graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({entityType:'bank_transaction',entityId:bank})]));
 expect(graph.coverage.countScope).toBe('visited_population');expect(graph.coverage.gaps).toEqual(expect.arrayContaining([expect.objectContaining({reason:'NO_DOCUMENT_IN_VISITED_GRAPH'})]));
 expect((await f.call('transaction_evidence_chain',args,'u3')).result?.isError).toBe(true);
 for(const module of ['banking','audit']){
  await f.pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.f.companyA,f.f.u1.id,module]);
  try{expect((await history()).result?.isError).toBe(true);
   expect((await f.call(module==='banking'?'transaction_evidence_chain':'mcp_call_history',module==='banking'?args:{})).result?.isError).toBe(true);
  }finally{await f.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.f.companyA,f.f.u1.id,module]);}
 }
 expect((await f.pool.query('SELECT count(*)::int AS count FROM control_change_events WHERE company_id=$1',[f.f.companyA])).rows[0].count).toBe(2);
 expect(await f.effects()).toEqual([]);
});
