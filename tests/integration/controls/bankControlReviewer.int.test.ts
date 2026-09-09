import {afterAll,beforeAll,expect,it} from 'vitest';
import {bankControlReadFixture} from './bankControlReadFixture';
let f:Awaited<ReturnType<typeof bankControlReadFixture>>;
beforeAll(async()=>{f=await bankControlReadFixture();});afterAll(async()=>{if(f)await f.close();});
async function requested(){const p=await f.prepare(),a=await f.pending(p.operation);expect(a.status).toBe(200);return{...p,approvalId:a.body.data.id};}
it('independent reviewer can see exact bank plan only through its linked approval',async()=>{
 const p=await requested(),r=await f.read(undefined,undefined,'u2',p.approvalId);
 expect(r.status).toBe(200);expect(r.body.data).toMatchObject({bankTransactionId:p.bankTransactionId,prepared:{total:0},selected:{intentId:p.intentId,requesterIsCurrentPerson:false,plan:{kind:'account',lines:[{accountId:f.contra,amount:'115.23'}]},approval:{id:p.approvalId,status:'pending'},approvalVisibility:'visible'}});
 expect((await f.read(p.bankTransactionId,p.intentId)).body.data.selected.requesterIsCurrentPerson).toBe(true);
 expect((await f.read(p.bankTransactionId,p.intentId,'u2')).status).toBe(400);
 expect((await f.read(p.bankTransactionId,undefined,'u2')).body.data.prepared.items).toEqual([]);
});
it('approval-addressed lookup refuses revoked approval rights instead of silently exposing another maker plan',async()=>{
 const p=await requested();await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'approvals',false)",[f.fixture.companyA,f.fixture.u2.id]);
 try{expect((await f.read(p.bankTransactionId,undefined,'u2',p.approvalId)).status).toBe(403);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='approvals'",[f.fixture.companyA,f.fixture.u2.id]);}
});
it('foreign tenant, wrong bank and mixed detail references cannot broaden reviewer access',async()=>{
 const p=await requested();
 for(const r of [await f.read(p.bankTransactionId,undefined,'u3',p.approvalId),await f.read(await f.source(),undefined,'u2',p.approvalId),await f.read(p.bankTransactionId,p.intentId,'u2',p.approvalId)])expect(r.status).toBeGreaterThanOrEqual(400);
});
