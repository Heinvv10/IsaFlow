import {afterAll,beforeAll,expect,it} from 'vitest';
import {z} from 'zod';
import {uuidBoundaryFixture,upper,runBaselineSeed,type Identity} from './uuidBoundaryFixture';
import {seedArCompany,seedArInvoice} from './arUuidFixture';
import {approveCustomerInvoice,type ApproveCustomerInvoiceResult} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
let f:Awaited<ReturnType<typeof uuidBoundaryFixture>>,customer:string;
beforeAll(async()=>{f=await uuidBoundaryFixture();customer=await seedArCompany(f.pool,f.f.companyA);},60000);
afterAll(async()=>{await f?.close();});
const ref=(entityId:string)=>({entityType:'customer_invoice',entityId,operation:'customer_invoice.post' as const});
const invoice=()=>seedArInvoice(f.pool,f.f.companyA,customer,f.f.u1.id);
function approve(id:string,approvalId?:string,as:Identity=f.f.u1){
 return f.actor(()=>approveCustomerInvoice(as.companyId,id,as.id,approvalId?{approvalId}:undefined),'u1',as);
}
async function withPolicy(fn:()=>Promise<void>){
 const [rule]=(await f.pool.query(`INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
  VALUES($1,'Synthetic UUID invoice approval','customer_invoice','amount','any',0,'admin') RETURNING id`,[f.f.companyA])).rows;
 try{await fn();}finally{await f.pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[f.f.companyA,rule.id]);}
}
async function population(id:string,company=f.f.companyA){
 const journals=(await f.pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_invoice' AND source_record_id=$2::uuid ORDER BY id",[company,id])).rows;
 const totals=(await f.pool.query(`SELECT COALESCE(sum(l.debit),0)::text AS debit,COALESCE(sum(l.credit),0)::text AS credit FROM gl_journal_lines l
  JOIN gl_journal_entries j ON j.company_id=l.company_id AND j.id=l.journal_entry_id
  WHERE j.company_id=$1 AND j.source='auto_invoice' AND j.source_record_id=$2::uuid AND j.status='posted'`,[company,id])).rows[0];
 const [row]=(await f.pool.query('SELECT status,gl_journal_entry_id FROM customer_invoices WHERE company_id=$1 AND id=$2',[company,id])).rows;
 return{journals,totals,invoice:row,effects:await f.effects('customer_invoice','customer_invoice.post',id,company)};
}
function expectOnePosting(saved:Awaited<ReturnType<typeof population>>,journal:string|null){
 expect(saved.journals).toEqual([{id:journal}]);expect(saved.effects).toHaveLength(1);
 expect(saved.totals).toEqual({debit:'115.00',credit:'115.00'});expect(saved.invoice).toEqual({status:'approved',gl_journal_entry_id:journal});
}
it.each([false,true])('replays an approved invoice posting through either UUID case after initial uppercase=%s approval',async uppercase=>{
 const id=await invoice(),caseVariant=upper(id);
 const first=await approve(uppercase?caseVariant:id);
 expect(first.id).toBe(id);
 await expect(approve(id)).resolves.toEqual(first);
 await expect(approve(caseVariant)).resolves.toEqual(first);
 expectOnePosting(await population(id),first.glJournalEntryId);
});
it('cannot post one invoice twice through independently approved UUID case variants',async()=>{
 await withPolicy(async()=>{
  const id=await invoice(),first=await approve(id,await f.approve(ref(id)));
  const second=await f.attempt(async()=>approve(upper(id),await f.approve(ref(upper(id)))));
  expectOnePosting(await population(id),first.glJournalEntryId);
  if(second.value)expect(second.value).toEqual(first);else expect(second.error).toBeInstanceOf(Error);
 });
});
it('serializes concurrently approved lower and uppercase invoice postings to one journal',async()=>{
 await withPolicy(async()=>{
  const id=await invoice(),lowerApproval=await f.approve(ref(id)),upperApproval=await f.approve(ref(upper(id)));
  const outcomes=await Promise.allSettled([approve(id,lowerApproval),approve(upper(id),upperApproval)]);
  const fulfilled=outcomes.filter((o):o is PromiseFulfilledResult<ApproveCustomerInvoiceResult>=>o.status==='fulfilled');
  expect(fulfilled).toHaveLength(1);
  expectOnePosting(await population(id),fulfilled[0]!.value.glJournalEntryId);
 });
});
const seedSchema=z.object({fixture:z.object({companyA:z.string().uuid(),u1:z.object({id:z.string().uuid(),companyId:z.string().uuid()})}),
 invoice:z.string().uuid(),result:z.object({id:z.string(),status:z.literal('approved'),glJournalEntryId:z.string().uuid()}).passthrough(),
 keys:z.object({encryption:z.string(),fingerprint:z.string()})});
it('replays a genuine fad0f57f7 uppercase invoice posting receipt through either UUID case without rewriting it',async()=>{
 const seed=seedSchema.parse(await runBaselineSeed('arPostingLegacyUuidFixture.ts',['arUuidFixture.ts']));
 const prior={encryption:process.env.ENCRYPTION_KEY,fingerprint:process.env.CONTROL_FINGERPRINT_KEY};
 process.env.ENCRYPTION_KEY=seed.keys.encryption;process.env.CONTROL_FINGERPRINT_KEY=seed.keys.fingerprint;
 try{
  const as=seed.fixture.u1,company=seed.fixture.companyA,retained=async()=>(await f.pool.query(
   "SELECT to_jsonb(e) AS row FROM control_operation_effects e WHERE company_id=$1 AND entity_type='customer_invoice' AND lower(entity_id)=$2 ORDER BY id",[company,seed.invoice])).rows;
  const before=await retained();
  expect(before).toHaveLength(1);expect(before[0].row.entity_id).toBe(upper(seed.invoice));expect(seed.result.id).toBe(upper(seed.invoice));
  await expect(approve(upper(seed.invoice),undefined,as)).resolves.toEqual(seed.result);
  await expect(approve(seed.invoice,undefined,as)).resolves.toEqual(seed.result);
  expect(await retained()).toEqual(before);
  expectOnePosting(await population(seed.invoice,company),seed.result.glJournalEntryId);
 }finally{process.env.ENCRYPTION_KEY=prior.encryption;process.env.CONTROL_FINGERPRINT_KEY=prior.fingerprint;}
});
