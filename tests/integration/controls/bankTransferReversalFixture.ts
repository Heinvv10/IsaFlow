import {transferControlFixture} from './bankTransferControlFixture';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
export async function transferReversalFixture(){
 const f=await transferControlFixture();
 async function posted(amount='-115.23',withOpposite=true){
  const bank=await f.bank(f.from,amount),opposite=withOpposite?await f.bank(f.to,amount.startsWith('-')?amount.slice(1):`-${amount}`):null;
  const intent=await f.prepare(bank),approval=await f.approve(intent.operation),effect=await f.execute(intent.intentId,approval);
  return{bank,opposite,intent,effect};
 }
 const prepareInverse=(originalIntentId:string,person:'u1'|'u2'='u1')=>f.actor(ctx=>prepareBankAllocationReversal(ctx,{originalIntentId,reversalDate:'2026-09-10',reason:'Synthetic transfer correction'}),person);
 const executeInverse=(intentId:string,approvalId:string,person:'u1'|'u2'='u1')=>f.actor(ctx=>executeBankAllocationReversal(ctx,intentId,{approvalId}),person);
 const journalRows=async()=>(await f.pool.query('SELECT id,source,source_record_id,status,reversed_at,reversal_of_id,entry_date::text FROM gl_journal_entries WHERE company_id=$1 ORDER BY id',[f.f.companyA])).rows;
 const lineRows=async(journalId:string)=>(await f.pool.query('SELECT gl_account_id,debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 ORDER BY gl_account_id',[f.f.companyA,journalId])).rows;
 const reversalIntent=async(id:string)=>(await f.pool.query('SELECT * FROM control_bank_allocation_reversal_intents WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0];
 async function snapshot(){return{...await f.snapshot(),journals:await journalRows(),
  fullBanks:(await f.pool.query('SELECT * FROM bank_transactions WHERE company_id=$1 ORDER BY id',[f.f.companyA])).rows,
  lines:(await f.pool.query('SELECT * FROM gl_journal_lines WHERE company_id=$1 ORDER BY id',[f.f.companyA])).rows,
  versions:(await f.pool.query('SELECT * FROM control_entity_versions WHERE company_id=$1 ORDER BY entity_type,entity_id',[f.f.companyA])).rows};}
 return{...f,posted,prepareInverse,executeInverse,journalRows,lineRows,reversalIntent,snapshot};
}
