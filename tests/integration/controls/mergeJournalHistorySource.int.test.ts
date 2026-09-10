import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferControlFixture} from './bankTransferControlFixture';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
import {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
let f:Awaited<ReturnType<typeof transferControlFixture>>,manual:string,payroll:string;
async function retained(source:string){
 const id=randomUUID();await f.pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,status,created_by) VALUES($1,$2,$1::text,'2026-09-09','Synthetic individual directive detail',$3,'draft',$4)",[id,f.f.companyA,source,f.f.u1.id]);
 await f.pool.query("INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description) VALUES($1,$2,$3,42,0,'Synthetic individual gross'),($1,$2,$4,0,42,'Synthetic individual net')",[f.f.companyA,id,f.from,f.to]);
 const header=(await f.pool.query('SELECT * FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0];
 const lines=(await f.pool.query('SELECT * FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 ORDER BY id',[f.f.companyA,id])).rows;
 const accounts=(await f.pool.query('SELECT * FROM gl_accounts WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.f.companyA,[f.from,f.to]])).rows;
 const image={header,lines,accounts};
 await f.actor(ctx=>recordCommittedChange(ctx,{entityType:'journal_entry',entityId:id,previousVersion:null,newVersion:1,action:`accounts_merged:${randomUUID()}`,accountingDate:'2026-09-09',before:image,after:image,bindingHash:null,protectedEvidenceRef:null}));return id;
}
beforeAll(async()=>{
 f=await transferControlFixture();manual=await retained('manual');payroll=await retained('auto_payroll');
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll_sensitive',false)",[f.f.companyA,f.f.u1.id]);
},30000);afterAll(async()=>{if(f)await f.close();});
const read=(id:string)=>f.actor(ctx=>readControlEntityHistory(ctx,{entityType:'journal_entry',entityId:id}));
it('allows ordinary manual merge history with reports/audit and no sensitive payroll access',async()=>{expect((await read(manual)).items).toHaveLength(1);});
it('refuses full retained payroll journal to reports/audit-only authority',async()=>{await expect(read(payroll)).rejects.toThrow();});
it('current mutable manual classification cannot hide the retained payroll source',async()=>{
 await f.pool.query("UPDATE gl_journal_entries SET source='manual' WHERE company_id=$1 AND id=$2",[f.f.companyA,payroll]);await expect(read(payroll)).rejects.toThrow();
});
it('allows current authorized full history and still refuses foreign tenant',async()=>{
 await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll_sensitive'",[f.f.companyA,f.f.u1.id]);
 const result=await read(payroll);expect(result.items[0]?.before).toMatchObject({header:{source:'auto_payroll'},lines:expect.arrayContaining([expect.objectContaining({description:'Synthetic individual gross'})])});
 const client=await f.pool.connect(),user=f.f.u3,claims={sub:user.id,role:'authenticated',company_id:user.companyId};
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  await expect(withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{companyId:user.companyId,personId:user.id,authMethod:'cookie'},()=>readControlEntityHistory(requireControlTx(),{entityType:'journal_entry',entityId:payroll}))).rejects.toThrow();
 }finally{await client.query('ROLLBACK');client.release();}
});
