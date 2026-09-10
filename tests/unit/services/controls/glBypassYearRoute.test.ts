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
