import {afterAll,beforeAll,expect,it} from 'vitest';
import {bankDimensionsFixture} from './bankDimensionsFixture';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
let f:Awaited<ReturnType<typeof bankDimensionsFixture>>;
beforeAll(async()=>{f=await bankDimensionsFixture();});afterAll(async()=>{if(f)await f.close();});
async function planned(){const bankTransactionId=await f.source(),dims=await f.dimensions();return{bankTransactionId,dims,plan:{version:1,kind:'account',bankTransactionId,lines:[{accountId:f.contra,amount:'115.23',...dims}]}};}
it('actual owned dimension preparation posts exact classifications and preserves them on approved inverse',async()=>{
 const p=await planned(),intent=await f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan)),approvalId=await f.approve(intent.operation);
 const posted=await f.actor(()=>executeBankAllocation(requireControlTx(),intent.intentId,{approvalId}));
 const lines=(await f.pool.query('SELECT gl_account_id,cc1_id,cc2_id,bu_id,cost_center_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.fixture.companyA,posted.journalEntryId])).rows;
 expect(lines.find(l=>l.gl_account_id===f.contra)).toMatchObject({cc1_id:p.dims.cc1Id,cost_center_id:p.dims.cc1Id,cc2_id:p.dims.cc2Id,bu_id:p.dims.buId});
 expect(lines.find(l=>l.gl_account_id===f.bank)).toMatchObject({cc1_id:null,cc2_id:null,bu_id:null});
 const reverse=await f.actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:intent.intentId,reversalDate:'2026-09-10',reason:'Synthetic dimension correction'})),reverseApproval=await f.approve(reverse.operation);
 const inverse=await f.actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:reverseApproval}));
 expect((await f.pool.query('SELECT cc1_id,cc2_id,bu_id,cost_center_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND gl_account_id=$3',[f.fixture.companyA,inverse.reversalJournalEntryId,f.contra])).rows[0]).toMatchObject({cc1_id:p.dims.cc1Id,cc2_id:p.dims.cc2Id,bu_id:p.dims.buId,cost_center_id:p.dims.cc1Id});
});
it('selected dimension changes invalidate prepared approval before financial effects',async()=>{
 const p=await planned(),intent=await f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan)),approvalId=await f.approve(intent.operation);
 await f.pool.query("UPDATE cost_centres SET code='changed-'+left(id::text,8),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[f.fixture.companyA,p.dims.cc2Id]);
 await expect(f.actor(()=>executeBankAllocation(requireControlTx(),intent.intentId,{approvalId}))).rejects.toThrow(/changed|stale/i);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.fixture.companyA,p.bankTransactionId])).rows).toEqual([]);
});
it('foreign, inactive and wrong-type dimensions refuse preparation',async()=>{
 const p=await planned(),foreign=await f.dimensions(f.fixture.companyB);
 for(const patch of [{cc1Id:foreign.cc1Id},{cc2Id:foreign.cc2Id},{buId:foreign.buId},{cc1Id:p.dims.cc2Id}])await expect(f.actor(()=>prepareBankAllocation(requireControlTx(),{...p.plan,lines:[{...p.plan.lines[0],...patch}]}))).rejects.toThrow(/dimension|owned|type/i);
 await f.pool.query('UPDATE business_units SET is_active=false WHERE company_id=$1 AND id=$2',[f.fixture.companyA,p.dims.buId]);
 await expect(f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan))).rejects.toThrow(/dimension|active/i);
});
