import {expect,it,vi} from 'vitest';
import type {NextApiRequest,NextApiResponse} from 'next';
const metered=vi.hoisted(()=>vi.fn());
const close=vi.hoisted(()=>vi.fn(async()=>({dryRun:true,netIncome:0,preview:{}})));
vi.mock('@/modules/accounting/services/gl/yearEndService',()=>({closeFiscalYear:close,listFiscalYears:vi.fn()}));
vi.mock('@/lib/auth',()=>({withAuth:(x:unknown)=>x,withRole:()=>((x:unknown)=>x)}));
vi.mock('@/lib/auth/withCsrf',()=>({withCsrf:(x:unknown)=>x}));
vi.mock('@/lib/api-error-handler',()=>({withErrorHandler:(x:unknown)=>x}));
vi.mock('@/lib/billing/withFlowMeter',()=>({withFlowMeter:()=>((handler:(...args:unknown[])=>unknown)=>(...args:unknown[])=>{metered();return handler(...args);})}));
vi.mock('@/modules/billing/services/flowOperationCatalog',()=>({getFlowCost:()=>0}));
const logger=vi.hoisted(()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}));
vi.mock('@/lib/logger',()=>({log:logger}));
import handler from '../../../../pages/api/accounting/year-end';
it('forwards an explicit approval reference and preview flag to the shared financial close',async()=>{
 const approvalId='11111111-1111-1111-1111-111111111111';
 const req={method:'POST',companyId:'company',user:{id:'person'},body:{action:'close',yearLabel:'2025',approvalId,dryRun:true}} as unknown as NextApiRequest;
 const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);
 await handler(req,res as unknown as NextApiResponse);
 expect(close).toHaveBeenCalledWith('company','2025','person',{approvalId,dryRun:true});
 expect(metered).not.toHaveBeenCalled();
});
it('answers an approval-bound close with a non-2xx status, not 200 with an error body',async()=>{
 close.mockResolvedValueOnce({error:'approval_required'} as never);
 const req={method:'POST',companyId:'company',user:{id:'person'},body:{action:'close',yearLabel:'2025',dryRun:true}} as unknown as NextApiRequest;
 const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);
 await handler(req,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(409);
 expect(res.status).not.toHaveBeenCalledWith(200);
});
it('answers misaligned fiscal periods with a non-2xx status and both date ranges',async()=>{
 // The outcome that refuses on every production company; the integration test
 // that drives it over HTTP does not run without a database, so it is pinned here too.
 close.mockResolvedValueOnce({error:'period_range_mismatch',expected:{startDate:'2024-03-01',endDate:'2025-02-28'},
  actual:{startDate:'2025-01-01',endDate:'2025-12-31'},startMonth:3} as never);
 const req={method:'POST',companyId:'company',user:{id:'person'},body:{action:'close',yearLabel:'2025'}} as unknown as NextApiRequest;
 const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);
 await handler(req,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(409);
 const body=JSON.stringify(res.json.mock.calls);
 expect(body).toMatch(/2025-01-01 to 2025-12-31/);
 expect(body).toMatch(/2024-03-01 to 2025-02-28/);
 expect(body).toMatch(/March/);
});
it('answers an unusable supplied approval with a caller error, not a 500',async()=>{
 close.mockRejectedValueOnce(Object.assign(new Error('Approval not found'),{code:'OPERATION_APPROVAL_NOT_EXECUTABLE'}));
 const req={method:'POST',companyId:'company',user:{id:'person'},body:{action:'close',yearLabel:'2025',dryRun:true,
  approvalId:'11111111-1111-1111-1111-111111111111'}} as unknown as NextApiRequest;
 const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);
 await handler(req,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(409);
 expect(JSON.stringify(res.json.mock.calls)).toMatch(/Approval not found/);
});
const post=async(body:Record<string,unknown>)=>{
 const req={method:'POST',companyId:'company',user:{id:'person'},body:{action:'close',yearLabel:'2025',...body}} as unknown as NextApiRequest;
 const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);
 await handler(req,res as unknown as NextApiResponse);return res;
};
it('answers the refusal shape the control functions actually raise, and logs it',async()=>{
 // What migration 627 raises: SQLSTATE 42501 preserved, carrying the marker.
 logger.warn.mockClear();
 close.mockRejectedValueOnce(Object.assign(new Error('Approval authorities unavailable'),{code:'42501',suppliedApprovalRefusal:true}));
 const res=await post({dryRun:true,approvalId:'11111111-1111-1111-1111-111111111111'});
 expect(res.status).toHaveBeenCalledWith(409);
 expect(JSON.stringify(res.json.mock.calls)).toMatch(/cannot be used/);
 expect(logger.warn).toHaveBeenCalled();
});
it('does NOT answer a stored-approval integrity failure as a caller error',async()=>{
 // 'Approval material is invalid' is a tamper/canonicalisation detector: it must
 // stay a server failure that monitoring sees, not a 409 quoting it back.
 logger.error.mockClear();
 close.mockRejectedValueOnce(new Error('Approval material is invalid'));
 const res=await post({dryRun:true,approvalId:'11111111-1111-1111-1111-111111111111'});
 expect(res.status).toHaveBeenCalledWith(500);
 expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/Approval material is invalid/);
 expect(logger.error).toHaveBeenCalled();
});
