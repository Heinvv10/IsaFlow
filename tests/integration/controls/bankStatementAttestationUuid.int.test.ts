import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {uuidBoundaryFixture,upper} from './uuidBoundaryFixture';
import {insertCaseVariantReceipt,appendEntityVersion} from './intentReceiptRows';
import {prepareBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationPreparation';
import {executeBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationEffect';
import {queryVerifiedBankStatements} from '@/modules/accounting/services/controls/bankStatementAttestationQuery';
let f:Awaited<ReturnType<typeof uuidBoundaryFixture>>;
beforeAll(async()=>{f=await uuidBoundaryFixture();await f.pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[f.f.companyA]);},60000);
afterAll(async()=>{await f?.close();});
type Attested=Awaited<ReturnType<typeof executeBankStatementAttestation>>;
/** Fresh owned bank account and actual statement bytes per case, so each intent has its own source. */
async function prepared(){
 const account=randomUUID(),document=randomUUID(),bytes=Buffer.from(`Synthetic UUID statement ${document}`);
 await f.pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level)
  VALUES($1::uuid,$2,left($1::text,12),'Synthetic UUID statement bank','asset','bank','debit',true,3)`,[account,f.f.companyA]);
 await f.pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,status) VALUES($1,$2,'synthetic-uuid-statement.pdf','pdf','matched')",[document,f.f.companyA]);
 await capturedStorage().seed(f.pool,f.f.companyA,document,bytes);
 const saved=await f.actor(ctx=>prepareBankStatementAttestation(ctx,{bankAccountId:account,sourceDocumentId:document,
  expectedSourceHash:createHash('sha256').update(bytes).digest('hex'),periodStart:'2026-09-01',periodEnd:'2026-09-30',
  sourceCount:0,openingBalance:'-10',closingBalance:'-10',currency:'ZAR'}));
 upper(saved.intentId);return saved;
}
const execute=(id:string,approvalId?:string)=>f.actor(ctx=>executeBankStatementAttestation(ctx,id,approvalId));
async function state(id:string){
 const verified=await f.actor(ctx=>queryVerifiedBankStatements(ctx,null));
 const approvals=await f.approvals('bank_statement_attestation_intent',id);
 return{effects:await f.effects('bank_statement_attestation_intent','bank_statement.attest',id),
  reader:verified.rows.filter(r=>r.row.id===id).map(r=>r.active),consumed:approvals.filter(a=>a.status==='consumed').length,
  journals:(await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[f.f.companyA])).rows};
}
function expectOneAttestation(saved:Awaited<ReturnType<typeof state>>){
 expect(saved.effects).toHaveLength(1);expect(saved.consumed).toBe(1);expect(saved.reader).toEqual([true]);expect(saved.journals).toEqual([]);
}
it.each([false,true])('replays a statement attestation through either UUID case after initial uppercase=%s execution without another approval',async uppercase=>{
 const p=await prepared(),approval=await f.approve(p.operation),caseVariant=upper(p.intentId);
 const first=await execute(uppercase?caseVariant:p.intentId,approval);
 expect(first.intentId).toBe(p.intentId);
 await expect(execute(p.intentId)).resolves.toEqual(first);
 await expect(execute(caseVariant)).resolves.toEqual(first);
 expectOneAttestation(await state(p.intentId));
});
it('reads an uppercase-first attestation back as an active locally reviewed statement',async()=>{
 const p=await prepared();
 await execute(upper(p.intentId),await f.approve(p.operation));
 expectOneAttestation(await state(p.intentId));
});
it('cannot attest one statement twice through an independently approved UUID case variant',async()=>{
 const p=await prepared(),first=await execute(p.intentId,await f.approve(p.operation));
 const second=await f.attempt(async()=>execute(upper(p.intentId),await f.approve({...p.operation,entityId:upper(p.intentId)})));
 expectOneAttestation(await state(p.intentId));
 if(second.value)expect(second.value).toEqual(first);else expect(second.error).toBeInstanceOf(Error);
});
it('serializes concurrently executed independently approved lower and uppercase attestations to one effect',async()=>{
 const p=await prepared(),lowerApproval=await f.approve(p.operation),upperApproval=await f.approve({...p.operation,entityId:upper(p.intentId)});
 const outcomes=await Promise.allSettled([execute(p.intentId,lowerApproval),execute(upper(p.intentId),upperApproval)]);
 expect(outcomes.filter((o):o is PromiseFulfilledResult<Attested>=>o.status==='fulfilled')).toHaveLength(1);
 expectOneAttestation(await state(p.intentId));
});
/**
 * The kernel finds a prior effect by the approval's operation_id and by binding_hash, and the first
 * effect bumps the intent's entity version — so a SECOND same-case approval requested afterwards
 * carries a new operation_id and a new binding_hash and misses both. Only the effect's own
 * unexecuted-intent guard stands between that and a second committed attestation.
 */
it('cannot attest one statement twice through a second same-case approval requested after the effect',async()=>{
 const p=await prepared(),first=await execute(p.intentId,await f.approve(p.operation));
 const second=await f.attempt(async()=>execute(p.intentId,await f.approve(p.operation)));
 expectOneAttestation(await state(p.intentId));
 // The kernel lets it through; the effect's own guard is what refuses.
 expect(second.error instanceof Error?second.error.message:second.value).toBe('Unexecuted statement attestation belonging to requester required');
 expect(first).toBeDefined();
});
/**
 * SYNTHESIZED legacy state, not old-code output: the retained control_entity_versions row is rewritten
 * by hand to the spelling old code would have stored, because no fad0f57f7 baseline seed exists for
 * this operation. A receipt found but a version join missed still reports the review dead.
 */
it('reads a statement back as active when its retained version row kept a legacy uppercase entity_id',async()=>{
 const p=await prepared();
 await execute(p.intentId,await f.approve(p.operation));
 const forked=async()=>(await f.pool.query(`SELECT entity_id,version FROM control_entity_versions
  WHERE company_id=$1 AND entity_type='bank_statement_attestation_intent' AND lower(entity_id)=$2 ORDER BY entity_id`,[f.f.companyA,p.intentId])).rows;
 const rewritten=await f.pool.query(`UPDATE control_entity_versions SET entity_id=upper(entity_id)
  WHERE company_id=$1 AND entity_type='bank_statement_attestation_intent' AND entity_id=$2 RETURNING entity_id`,[f.f.companyA,p.intentId]);
 expect(rewritten.rows).toEqual([{entity_id:upper(p.intentId)}]);
 expectOneAttestation(await state(p.intentId));
 // The lineage is extended in place, so a later write never forks a second spelling beside it.
 await f.attempt(()=>execute(p.intentId));
 expect((await forked()).map(r=>r.entity_id)).toEqual([upper(p.intentId)]);
});
/**
 * SYNTHESIZED legacy state, not old-code output: the retained effect's entity_id is rewritten by hand
 * to the spelling old code stored, because no fad0f57f7 baseline seed exists for this operation.
 * UNIQUE(company_id,operation,entity_id,binding_hash) is case-sensitive, so the database would happily
 * hold a second lowercase effect beside the legacy one; only the case-insensitive receipt read stops it.
 */
it('cannot execute a second statement attestation beside a receipt that kept a legacy uppercase entity_id',async()=>{
 const p=await prepared(),first=await execute(p.intentId,await f.approve(p.operation));
 const rewritten=await f.pool.query(`UPDATE control_operation_effects SET entity_id=upper(entity_id)
  WHERE company_id=$1 AND entity_type='bank_statement_attestation_intent' AND operation='bank_statement.attest' AND entity_id=$2 RETURNING entity_id`,[f.f.companyA,p.intentId]);
 expect(rewritten.rows).toEqual([{entity_id:upper(p.intentId)}]);
 // A fresh approval carries a new operation_id and a new binding_hash, so neither kernel guard
 // sees the legacy effect; the receipt read is the only thing that refuses the second execution.
 const second=await f.attempt(async()=>execute(p.intentId,await f.approve(p.operation)));
 expect(second.error instanceof Error?second.error.message:second.value).toBe('Unexecuted statement attestation belonging to requester required');
 expectOneAttestation(await state(p.intentId));
 await expect(execute(p.intentId)).resolves.toEqual(first);
});
/**
 * A twin receipt and a forked version row are two rows apiece for one intent. A plain join on
 * lower(entity_id) fans out, so one statement is read as two and the population count doubles.
 */
it('reads a twinned receipt and a forked version row as one statement, not two',async()=>{
 const p=await prepared();
 await execute(p.intentId,await f.approve(p.operation));
 const committed=await f.effects('bank_statement_attestation_intent','bank_statement.attest',p.intentId);
 expect(committed).toHaveLength(1);
 await insertCaseVariantReceipt(f.pool,f.f.u1,committed[0]!.id);
 await appendEntityVersion(f.pool,f.f.u1,'bank_statement_attestation_intent',upper(p.intentId),7);
 expect(await f.effects('bank_statement_attestation_intent','bank_statement.attest',p.intentId)).toHaveLength(2);
 const verified=await f.actor(ctx=>queryVerifiedBankStatements(ctx,null));
 expect(verified.rows.filter(r=>r.row.id===p.intentId)).toHaveLength(1);
 expect(verified.populationCount).toBe(verified.rows.length);
});
