import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({ctx:{issued:'fixture'},permission:vi.fn(async()=>undefined),snapshot:vi.fn(async()=>({id:'job',state:'queued'})),export:vi.fn(async()=>({id:'export',state:'queued'})),
 status:vi.fn(async()=>({state:'queued'})),header:vi.fn(),page:vi.fn(),snapshotChunk:vi.fn(async()=>({item:{ordinal:0},chunkOrdinal:0,bytes:new Uint8Array([0,255])})),files:vi.fn(),exportChunk:vi.fn(async()=>({file:{ordinal:0},chunkOrdinal:0,bytes:new Uint8Array([1,2])}))}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>mocks.ctx}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/auditJobService',()=>({enqueueAuditSnapshot:mocks.snapshot,getAuditJob:mocks.status}));
vi.mock('@/modules/accounting/services/controls/auditExportJobService',()=>({enqueueAuditExport:mocks.export}));
vi.mock('@/modules/accounting/services/controls/auditSnapshotIndexRead',()=>({readAuditSnapshotIndexHeader:mocks.header}));
vi.mock('@/modules/accounting/services/controls/auditSnapshotPageService',()=>({getAuditSnapshotPage:mocks.page,readAuditSnapshotChunk:mocks.snapshotChunk}));
vi.mock('@/modules/accounting/services/controls/auditExportReadService',()=>({getAuditExportFiles:mocks.files,readAuditExportChunk:mocks.exportChunk}));
import {auditDeliveryTools} from '@/lib/mcp/tools/auditDelivery';
import {validateToolArguments} from '@/lib/mcp/inputValidation';
beforeEach(()=>vi.clearAllMocks());
const id='11111111-1111-4111-8111-111111111111',ctx={userId:'user',companyId:'company',scopes:['read:reports'],tokenJti:'token',oauthAppId:null};
async function call(name:string,args:Record<string,unknown>){return auditDeliveryTools.find(tool=>tool.name===name)!.handler(args,ctx);}
const valid=[{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotency_key:'retry'},
 {snapshot_id:id,idempotency_key:'retry'},{job_id:id},{snapshot_id:id},{snapshot_id:id,section:'records'},
 {snapshot_id:id,section:'records',ordinal:0,chunk_ordinal:0},{job_id:id},{job_id:id,file_ordinal:0,chunk_ordinal:0},
 {first_snapshot_id:id,second_snapshot_id:id,idempotency_key:'compare'},{comparison_id:id,section:'records'}];
it('admits every actual tool contract through the registry input gate',()=>{
 auditDeliveryTools.forEach((tool,index)=>expect(validateToolArguments(tool,valid[index])).toMatchObject({ok:true}));
});
it('enforces UUID, key lengths and patterns before handlers',()=>{
 expect(validateToolArguments(auditDeliveryTools[0],{...valid[0],idempotency_key:''}).ok).toBe(false);
 expect(validateToolArguments(auditDeliveryTools[0],{...valid[0],idempotency_key:'contains spaces'}).ok).toBe(false);
 expect(validateToolArguments(auditDeliveryTools[2],{job_id:'not-a-uuid'}).ok).toBe(false);
 expect(validateToolArguments(auditDeliveryTools[6],{job_id:id,cursor:'01'}).ok).toBe(false);
});
it('accepts only a matching registry company assertion without forwarding it as business authority',async()=>{
 for(let index=0;index<2;index++){
  const tool=auditDeliveryTools[index]!,args={...valid[index],company_id:ctx.companyId};
  await expect(tool.authorize!(args,ctx)).resolves.toBeUndefined();
  expect((await tool.handler(args,ctx)).isError).not.toBe(true);
  await expect(tool.authorize!({...args,company_id:'other'},ctx)).rejects.toThrow();
  await expect(tool.handler({...args,company_id:'other'},ctx)).rejects.toThrow();
 }
});
it('declares bounded explicit contracts for enqueue and retained delivery',()=>{
 expect(auditDeliveryTools.map(tool=>tool.name)).toEqual(['audit_snapshot','export_audit_evidence','audit_job_status','audit_snapshot_manifest','audit_snapshot_items','audit_snapshot_chunk','audit_export_files','audit_export_chunk','compare_audit_snapshots','audit_comparison_items']);
 for(const tool of auditDeliveryTools){expect(tool.scope).toBe('read:reports');expect(tool.inputSchema.additionalProperties).toBe(false);expect(tool.requiresPost).not.toBe(true);}
 expect(auditDeliveryTools.filter(tool=>tool.write).map(tool=>tool.name)).toEqual(['audit_snapshot','export_audit_evidence','compare_audit_snapshots']);
 for(const tool of auditDeliveryTools.filter(tool=>tool.write)){expect(tool.perUserIdempotency).toBe(true);expect(tool.authorize).toBeTypeOf('function');}
});
it('derives all current source permissions again before replay and authenticates export source metadata',async()=>{
 await auditDeliveryTools[0].authorize!({cutoff:'2026-09-09',sources:['payroll','ap','bank'],checks:[],idempotency_key:'retry'},ctx);
 expect(mocks.permission.mock.calls.map(call=>call[1])).toEqual(['read:bank-tx','read:invoices','read:payroll','read:reports']);
 await auditDeliveryTools[1].authorize!({snapshot_id:id,idempotency_key:'retry'},ctx);
 expect(mocks.header).toHaveBeenCalledWith(mocks.ctx,id);
});
it('delegates enqueue to real shared interfaces with context-derived authority and explicit retry keys',async()=>{
 await call('audit_snapshot',{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotency_key:'retry'});
 expect(mocks.snapshot).toHaveBeenCalledWith(mocks.ctx,{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:'retry'});
 await call('export_audit_evidence',{snapshot_id:id,idempotency_key:'export-retry'});
 expect(mocks.export).toHaveBeenCalledWith(mocks.ctx,{snapshotId:id,idempotencyKey:'export-retry'});
});
it('rejects caller authority, oversized pages and missing retry keys before shared work',async()=>{
 for(const [name,args] of [['audit_snapshot',{cutoff:'2026-09-09',sources:['journals'],checks:[]}],['audit_export_files',{job_id:id,limit:101}],['audit_job_status',{job_id:id,company_id:id}]] as const)
  expect((await call(name,args)).isError).toBe(true);
});
it('returns exact bounded byte payloads as base64 with authenticated descriptors',async()=>{
 const snapshot=await call('audit_snapshot_chunk',{snapshot_id:id,section:'records',ordinal:0,chunk_ordinal:0});
 expect(JSON.parse(snapshot.content[0]!.text!)).toEqual({item:{ordinal:0},chunkOrdinal:0,bytesBase64:'AP8='});
 const exported=await call('audit_export_chunk',{job_id:id,file_ordinal:0,chunk_ordinal:0});
 expect(JSON.parse(exported.content[0]!.text!)).toEqual({file:{ordinal:0},chunkOrdinal:0,bytesBase64:'AQI='});
});

it('requires both ordered sources and bounded result pages at the comparison transport gate',()=>{
 const compare=auditDeliveryTools.find(tool=>tool.name==='compare_audit_snapshots');
 const results=auditDeliveryTools.find(tool=>tool.name==='audit_comparison_items');
 expect(compare).toBeDefined();expect(results).toBeDefined();
 for(const args of [{first_snapshot_id:id,idempotency_key:'retry'},
  {first_snapshot_id:id,second_snapshot_id:id,idempotency_key:'retry',permissions:['read:reports']},
  {first_snapshot_id:id,second_snapshot_id:id,idempotency_key:'retry',firstCanonicalHash:'a'.repeat(64)}])
  expect(validateToolArguments(compare!,args).ok).toBe(false);
 for(const args of [{comparison_id:id,section:'records',limit:101},{comparison_id:id,section:'records',cursor:'01'},
  {comparison_id:id,section:'unknown'},{comparison_id:id,section:'records',company_id:id}])
  expect(validateToolArguments(results!,args).ok).toBe(false);
});
