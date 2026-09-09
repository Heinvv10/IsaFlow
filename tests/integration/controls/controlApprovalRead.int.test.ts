import {beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {NextApiRequest,NextApiResponse} from 'next';
import {actor,bank,customer,fixture,pool,postedCash} from './cashApplicationFixture';
import {prepareBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {listOperationApprovals} from '@/modules/accounting/services/controls/approvalReadService';
import {controlApprovalsHandler} from '../../../pages/api/accounting/control-approvals';
let visibleId:string;const pendingIds:string[]=[];
async function bankIntent(){
 const id=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',115,'Synthetic approval read','imported')",[id,fixture.companyA,bank]);
 return actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:id,partyId:customer,applications:[]}));
}
beforeAll(async()=>{
 const doc=await postedCash();
 visibleId=(await actor(()=>requestOperationApproval(requireControlTx(),{entityType:'customer_invoice',entityId:doc.invoice,operation:'customer_invoice.cancel',reversalDate:'2026-09-10'}))).id;
 for(let index=0;index<3;index++){
  const prepared=await bankIntent();pendingIds.push((await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation))).id);
 }
});
async function deny(module:string,action:()=>Promise<void>){
 await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[fixture.companyA,fixture.u1.id,module]);
 try{await action();}finally{await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[fixture.companyA,fixture.u1.id,module]);}
}
it('paginates actual pending requests without duplicates or full binding disclosure',async()=>{
 const ids:string[]=[];let cursor:string|undefined;
 do{
  const page=await actor(()=>listOperationApprovals(requireControlTx(),{status:'pending',limit:1,...(cursor?{cursor}:{})}));
  expect(page.items).toHaveLength(1);expect(Object.keys(page.items[0]!).sort()).toEqual(['entityId','entityType','expiresAt','id','operation','requestedAt','status']);
  ids.push(page.items[0]!.id);cursor=page.nextCursor??undefined;
 }while(cursor);
 expect(ids).toEqual([...pendingIds].reverse());
});
it('filters denied domain operations inside SQL before page limits and cursors',async()=>{
 await deny('banking',async()=>{
  const page=await actor(()=>listOperationApprovals(requireControlTx(),{limit:1}));
  expect(page.items.map(item=>item.id)).toEqual([visibleId]);expect(page.nextCursor).toBeNull();
 });
});
it('rechecks read:approvals on every call',async()=>{
 await deny('approvals',async()=>{await expect(actor(()=>listOperationApprovals(requireControlTx(),{}))).rejects.toThrow(/permission|authority/i);});
});
it('rejects cursor tampering, changed rights, changed filter and foreign tenant replay',async()=>{
 const page=await actor(()=>listOperationApprovals(requireControlTx(),{status:'pending',limit:1}));expect(page.nextCursor).toBeTruthy();const cursor=page.nextCursor!;
 await expect(actor(()=>listOperationApprovals(requireControlTx(),{status:'pending',limit:1,cursor:cursor+'x'}))).rejects.toThrow(/cursor/i);
 await expect(actor(()=>listOperationApprovals(requireControlTx(),{status:'approved',limit:1,cursor}))).rejects.toThrow(/cursor/i);
 await expect(actor(()=>listOperationApprovals(requireControlTx(),{status:'pending',limit:1,cursor}),'u3')).rejects.toThrow(/cursor/i);
 await deny('banking',async()=>{await expect(actor(()=>listOperationApprovals(requireControlTx(),{status:'pending',limit:1,cursor}))).rejects.toThrow(/cursor/i);});
});
it('foreign company sees no approvals from the source tenant',async()=>{
 expect(await actor(()=>listOperationApprovals(requireControlTx(),{}),'u3')).toEqual({items:[],nextCursor:null});
});
function response(){const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};res.status.mockReturnValue(res);return res;}
async function dispatch(body:unknown,person:'u1'|'u2'='u1',bearer=false){
 const res=response();await actor(()=>controlApprovalsHandler({method:'POST',body,query:{}} as NextApiRequest,res as unknown as NextApiResponse),person,bearer);
 expect(res.status).toHaveBeenCalledWith(200);return res.json.mock.calls[0]![0].data;
}
it('actual REST handler requests and independently decides a real bound operation',async()=>{
 const prepared=await bankIntent();
 const requirements=await dispatch({action:'requirements',ref:prepared.operation});expect(requirements.requiresApproval).toBe(true);
 const requested=await dispatch({action:'request',ref:prepared.operation});expect(requested.status).toBe('pending');
 await expect(dispatch({action:'decide',approvalId:requested.id,decision:'approved'})).rejects.toThrow(/Self|independent/i);
 await expect(dispatch({action:'decide',approvalId:requested.id,decision:'approved'},'u2',true)).rejects.toThrow(/human/i);
 const decided=await dispatch({action:'decide',approvalId:requested.id,decision:'approved'},'u2');expect(decided.status).toBe('approved');
 const res=response();await actor(()=>controlApprovalsHandler({method:'GET',query:{action:'list',status:'approved',limit:'100'}} as unknown as NextApiRequest,res as unknown as NextApiResponse));
 expect(res.status).toHaveBeenCalledWith(200);expect(res.json.mock.calls[0]![0].data.items.some((item:{id:string})=>item.id===requested.id)).toBe(true);
 expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,prepared.intentId])).rows).toHaveLength(0);
});
it('retains exact microseconds and UUID tie-breaking across equal request timestamps',async()=>{
 const before=(await pool.query('SELECT id,requested_at::text AS requested_at FROM control_operation_approvals WHERE company_id=$1 AND id=ANY($2::uuid[])',[fixture.companyA,pendingIds])).rows;
 await pool.query("UPDATE control_operation_approvals SET requested_at='2026-09-09T10:00:00.123456Z' WHERE company_id=$1 AND id=ANY($2::uuid[])",[fixture.companyA,pendingIds]);
 try{
  const first=await actor(()=>listOperationApprovals(requireControlTx(),{status:'pending',limit:2}));expect(first.nextCursor).toBeTruthy();
  const second=await actor(()=>listOperationApprovals(requireControlTx(),{status:'pending',limit:2,cursor:first.nextCursor!}));
  expect([...first.items,...second.items].map(item=>item.id)).toEqual([...pendingIds].sort().reverse());expect(second.nextCursor).toBeNull();
 }finally{for(const row of before)await pool.query('UPDATE control_operation_approvals SET requested_at=$3::timestamptz WHERE company_id=$1 AND id=$2',[fixture.companyA,row.id,row.requested_at]);}
});

it('REST maps a current permission refusal to 403 without approving anything',async()=>{
 await deny('approvals',async()=>{
  const res=response();await actor(()=>controlApprovalsHandler({method:'GET',query:{}} as NextApiRequest,res as unknown as NextApiResponse));
  expect(res.status).toHaveBeenCalledWith(403);
 });
});
