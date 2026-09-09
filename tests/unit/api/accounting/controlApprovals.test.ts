import {expect,it,vi} from 'vitest';
import type {NextApiRequest,NextApiResponse} from 'next';
import {controlApprovalsHandler} from '../../../../pages/api/accounting/control-approvals';
import {withCsrf} from '@/lib/auth/withCsrf';
function response(){const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);return res;}
for(const body of [
 {action:'request',ref:{operation:'customer_payment.cancel',entityType:'customer_payment'}},
 {action:'request',ref:{operation:'customer_payment.cancel',entityType:'customer_payment',entityId:'11111111-1111-4111-8111-111111111111',personId:'forged'}},
 {action:'decide',approvalId:'11111111-1111-4111-8111-111111111111',decision:'approved',actor:'forged'},
 {action:'decide',approvalId:'not-uuid',decision:'approved'},
 {action:'unknown'},
])it(`strictly rejects malformed or injected POST ${JSON.stringify(body)}`,async()=>{
 const res=response();await controlApprovalsHandler({method:'POST',body,query:{}} as NextApiRequest,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(400);
});
for(const query of [{limit:['1','2']},{limit:'101'},{companyId:'forged'},{action:'pending',status:'approved'}])it(`strictly rejects malformed GET ${JSON.stringify(query)}`,async()=>{
 const res=response();await controlApprovalsHandler({method:'GET',query} as unknown as NextApiRequest,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(400);
});
it('actual CSRF wrapper refuses a missing double-submit token before dispatch',async()=>{
 const res=response();await withCsrf(controlApprovalsHandler)({method:'POST',body:{action:'request'},query:{},cookies:{},headers:{}} as NextApiRequest,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(403);
});
