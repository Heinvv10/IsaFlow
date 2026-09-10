import {beforeEach,expect,it,vi} from 'vitest';
import type {NextApiRequest,NextApiResponse} from 'next';
import {EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {AuditEnqueueQuotaError} from '@/modules/accounting/services/controls/auditEnqueueQuota';
const shared=vi.hoisted(()=>({enqueue:vi.fn(),page:vi.fn(),ctx:{synthetic:'adapter-only'}}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>shared.ctx}));
vi.mock('@/modules/accounting/services/controls/auditComparisonJobService',()=>({enqueueAuditComparison:shared.enqueue}));
vi.mock('@/modules/accounting/services/controls/auditComparisonPageService',()=>({getAuditComparisonPage:shared.page}));
import {auditComparisonsHandler} from '../../../pages/api/accounting/audit-comparisons';
const id='11111111-1111-4111-8111-111111111111';
function response(){const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);return res;}
async function invoke(method:string,body:unknown={},query:unknown={}){const res=response();await auditComparisonsHandler({method,body,query} as NextApiRequest,res as unknown as NextApiResponse);return res;}
beforeEach(()=>{vi.clearAllMocks();shared.enqueue.mockResolvedValue({id,state:'queued'});shared.page.mockResolvedValue({items:[],nextCursor:null});});
it('forwards strict POST identities through the shared parser and enqueue',async()=>{
 const body={firstSnapshotId:id,secondSnapshotId:id,idempotencyKey:'same'};expect((await invoke('POST',body)).status).toHaveBeenCalledWith(200);
 expect(shared.enqueue).toHaveBeenCalledWith(shared.ctx,body);
 for(const extra of [{companyId:id},{permissions:['read:reports']},{firstCanonicalHash:'a'.repeat(64)}])expect((await invoke('POST',{...body,...extra})).status).toHaveBeenCalledWith(400);
 expect(shared.enqueue).toHaveBeenCalledTimes(1);
});
it('converts a scalar bounded query limit and preserves the ordinal cursor',async()=>{
 expect((await invoke('GET',{}, {comparisonId:id,section:'records',limit:'2',cursor:'0'})).status).toHaveBeenCalledWith(200);
 expect(shared.page).toHaveBeenCalledWith(shared.ctx,{comparisonId:id,section:'records',limit:2,cursor:'0'});
});
it('refuses query arrays, unknown authority, invalid limits and cursors before delegation',async()=>{
 for(const extra of [{limit:['1','2']},{comparisonId:[id,id]},{companyId:id},{limit:'0'},{limit:'101'},{limit:'01'},{limit:'1.5'},{cursor:'01'},{section:'unknown'}])
  expect((await invoke('GET',{}, {comparisonId:id,section:'records',...extra})).status).toHaveBeenCalledWith(400);
 expect(shared.page).not.toHaveBeenCalled();
});
it('rejects unsupported methods without calling either shared service',async()=>{
 expect((await invoke('DELETE')).status).toHaveBeenCalledWith(405);expect(shared.page).not.toHaveBeenCalled();expect(shared.enqueue).not.toHaveBeenCalled();
});
it('returns current shared authority denial as forbidden for enqueue and read',async()=>{
 shared.enqueue.mockRejectedValueOnce(new EffectivePermissionError());shared.page.mockRejectedValueOnce(new EffectivePermissionError());
 expect((await invoke('POST',{firstSnapshotId:id,secondSnapshotId:id,idempotencyKey:'denied'})).status).toHaveBeenCalledWith(403);
 expect((await invoke('GET',{}, {comparisonId:id,section:'records'})).status).toHaveBeenCalledWith(403);
});
it('answers a refused comparison quota with 429, not a server error',async()=>{
 shared.enqueue.mockRejectedValueOnce(new AuditEnqueueQuotaError('audit_compare','member'));
 const res=await invoke('POST',{firstSnapshotId:id,secondSnapshotId:id,idempotencyKey:'quota'});
 expect(res.status,'a comparison quota refusal surfaced as a server error').toHaveBeenCalledWith(429);
 expect(res.json.mock.calls[0]?.[0]?.error).toMatchObject({code:'RATE_LIMIT',message:'Audit comparison quota exceeded (member)'});
});
it('names the missing permission in a 403, whichever it is',async()=>{
 shared.enqueue.mockRejectedValueOnce(new EffectivePermissionError('write:audit'));shared.page.mockRejectedValueOnce(new EffectivePermissionError('read:payroll'));
 const enqueue=await invoke('POST',{firstSnapshotId:id,secondSnapshotId:id,idempotencyKey:'denied'}),read=await invoke('GET',{}, {comparisonId:id,section:'records'});
 expect(enqueue.json.mock.calls[0]?.[0]?.error?.message).toBe('Current permission denied: write:audit is required');
 expect(read.json.mock.calls[0]?.[0]?.error?.message).toBe('Current permission denied: read:payroll is required');
 // A refusal that names no permission (an inactive membership, a revoked grant) keeps the general wording.
 shared.page.mockRejectedValueOnce(new EffectivePermissionError());
 expect((await invoke('GET',{}, {comparisonId:id,section:'records'})).json.mock.calls[0]?.[0]?.error?.message).toBe('Current permissions do not allow this operation.');
});
