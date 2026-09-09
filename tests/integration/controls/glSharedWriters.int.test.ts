import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { materializeGlOperation } from '@/modules/accounting/services/controls/glOperationMaterializer';
import { operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { requestOperationApproval, decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import {registerGeneratedJournal} from '@/modules/accounting/services/controls/generatedJournalPermit';
import { executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:7000});
let fixture:ForensicFixture;
const debitAccount=randomUUID(),creditAccount=randomUUID(),period=randomUUID();
async function actor<T>(person:'u1'|'u2'|'u3',fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
  const user=fixture[person],client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
    const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
    const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
      {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeAll(async()=>{
  fixture=await provisionForensicFixture(config);
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level)
    VALUES($1,$3,$4,'Synthetic debit','asset','debit',3),($2,$3,$5,'Synthetic credit','liability','credit',3)`,
    [debitAccount,creditAccount,fixture.companyA,debitAccount.slice(0,12),creditAccount.slice(0,12)]);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic GL period',1,2026,'2026-09-01','2026-09-30','open')`,[period,fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
async function journal():Promise<OperationRef>{
  const id=randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by)
    VALUES($1,$2,'2026-09-09',$3,'manual','draft',$4)`,[id,fixture.companyA,period,fixture.u1.id]);
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
    VALUES($1,$2,$3,115.10,0),($1,$2,$4,0,115.10)`,[id,fixture.companyA,debitAccount,creditAccount]);
  return{entityType:'journal_entry',entityId:id,operation:'journal.post'};
}
const hash=(material:Awaited<ReturnType<typeof materializeGlOperation>>)=>operationBindingHash({...material.binding,policies:[]});
it('binds actual ledger currency, exact balanced lines, accounts, period and company lockdown without history writes',async()=>{
  const ref=await journal();const material=await actor('u1',ctx=>materializeGlOperation(ctx,ref));
  expect(material.binding.amount).toBe('115.1');expect(material.binding.currency).toBe('ZAR');
  expect(material.binding.accountingDate).toBe('2026-09-09');expect(material.binding.beneficiaries).toEqual([]);
  expect(material.observedSources.map(s=>s.entityType)).toEqual(['journal_entry','company_gl_settings','gl_account','gl_account','fiscal_period']);
  expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
});
it('re-materializes changed line/account/period/company facts into different bindings',async()=>{
  const ref=await journal(),before=hash(await actor('u1',ctx=>materializeGlOperation(ctx,ref)));
  await pool.query("UPDATE gl_journal_lines SET description='changed classification narrative' WHERE company_id=$1 AND journal_entry_id=$2",[fixture.companyA,ref.entityId]);
  expect(hash(await actor('u1',ctx=>materializeGlOperation(ctx,ref)))).not.toBe(before);
  const changed=hash(await actor('u1',ctx=>materializeGlOperation(ctx,ref)));
  await pool.query("UPDATE gl_accounts SET account_name='Changed synthetic account' WHERE company_id=$1 AND id=$2",[fixture.companyA,debitAccount]);
  const accountChanged=hash(await actor('u1',ctx=>materializeGlOperation(ctx,ref)));
  expect(accountChanged).not.toBe(changed);
  try {
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
    const periodChanged=hash(await actor('u1',ctx=>materializeGlOperation(ctx,ref)));expect(periodChanged).not.toBe(accountChanged);
    await pool.query("UPDATE companies SET default_currency='USD',lockdown_enabled=true,lockdown_date='2026-09-01' WHERE id=$1",[fixture.companyA]);
    const currencyChanged=await actor('u1',ctx=>materializeGlOperation(ctx,ref));
    expect(currencyChanged.binding.currency).toBe('USD');expect(hash(currencyChanged)).not.toBe(periodChanged);
  } finally {
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
    await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false,lockdown_date=null WHERE id=$1",[fixture.companyA]);
  }
});
it('refuses foreign journals and exact imbalances',async()=>{
  const ref=await journal();await expect(actor('u3',ctx=>materializeGlOperation(ctx,ref))).rejects.toThrow();
  await pool.query('UPDATE gl_journal_lines SET debit=115.11 WHERE company_id=$1 AND journal_entry_id=$2 AND debit>0',[fixture.companyA,ref.entityId]);
  await expect(actor('u1',ctx=>materializeGlOperation(ctx,ref))).rejects.toThrow('exactly balanced');
});
it('binds an explicit reversal target and refuses an uncovered or earlier target',async()=>{
  const ref={...await journal(),operation:'journal.reverse' as const,reversalDate:'2026-09-15'};
  const material=await actor('u1',ctx=>materializeGlOperation(ctx,ref));expect(material.binding.accountingDate).toBe('2026-09-15');
  await expect(actor('u1',ctx=>materializeGlOperation(ctx,{...ref,reversalDate:'2026-10-15'}))).rejects.toThrow('Target fiscal period');
  await expect(actor('u1',ctx=>materializeGlOperation(ctx,{...ref,reversalDate:'2026-08-31'}))).rejects.toThrow('reversal date');
});

it('shared posting refuses missing context and current policy before the financial effect',async()=>{
  const ref=await journal();
  await expect(postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id)).rejects.toThrow('Authenticated');
  const rule=randomUUID();
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,approver_role)
    VALUES($1,$2,'Synthetic journal control','journal_entry','amount','any','admin')`,[rule,fixture.companyA]);
  try {
    await expect(actor('u1',()=>postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id))).rejects.toThrow('approval');
    expect((await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,ref.entityId])).rows[0].status).toBe('draft');
    const approval=await actor('u1',ctx=>requestOperationApproval(ctx,ref));
    await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));
    expect((await actor('u1',()=>postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id,{approvalId:approval.id}))).status).toBe('posted');
    expect((await actor('u1',()=>postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id,{approvalId:approval.id}))).status).toBe('posted');
    expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,ref.entityId])).rows).toHaveLength(1);
  } finally {await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[fixture.companyA,rule]);}
});
it('shared reversal posts one precisely dated contra under its generated child permit',async()=>{
  const ref=await journal();await actor('u1',()=>postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id));
  const rule=randomUUID();
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,approver_role)
    VALUES($1,$2,'Synthetic reverse policy','journal_entry','amount','any','admin')`,[rule,fixture.companyA]);
  let reversed:Awaited<ReturnType<typeof reverseJournalEntry>>;
  try {
    const intent={...ref,operation:'journal.reverse' as const,reversalDate:'2026-09-15'};
    const approval=await actor('u1',ctx=>requestOperationApproval(ctx,intent));
    await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));
    await expect(actor('u1',()=>reverseJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id,{approvalId:approval.id,reversalDate:'2026-09-16'}))).rejects.toThrow('material');
    reversed=await actor('u1',()=>reverseJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id,{approvalId:approval.id,reversalDate:'2026-09-15'}));
  } finally {await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[fixture.companyA,rule]);}
  expect(reversed.status).toBe('posted');expect(reversed.entryDate).toBe('2026-09-15');
  const original=(await pool.query('SELECT status,reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,ref.entityId])).rows[0];
  expect(original.status).toBe('posted');expect(original.reversed_at).not.toBeNull();
  const totals=(await pool.query(`SELECT sum(debit)::text AS debit,sum(credit)::text AS credit FROM gl_journal_lines
    WHERE company_id=$1 AND journal_entry_id=ANY($2::uuid[])`,[fixture.companyA,[ref.entityId,reversed.id]])).rows[0];
  expect(totals.debit).toBe(totals.credit);
  const net=(await pool.query('SELECT sum(debit-credit)::text AS amount FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=ANY($2::uuid[]) GROUP BY gl_account_id',[fixture.companyA,[ref.entityId,reversed.id]])).rows;
  expect(net.every(row=>row.amount==='0.00')).toBe(true);
  await expect(actor('u1',()=>reverseJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id))).rejects.toThrow('already reversed');
});
it('an active parent callback cannot post an arbitrary unregistered journal',async()=>{
  const parent=await journal(),unrelated=await journal();await actor('u1',()=>postJournalEntry(fixture.companyA,parent.entityId,fixture.u1.id));
  const reverseRef={...parent,operation:'journal.reverse' as const};
  await expect(actor('u1',ctx=>executeControlledOperation(ctx,reverseRef,null,async permit=>
    postJournalEntry(fixture.companyA,unrelated.entityId,fixture.u1.id,{parentControl:{permit,parent:reverseRef}})))).rejects.toThrow('authorized');
  expect((await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,unrelated.entityId])).rows[0].status).toBe('draft');
});
it('retains period, inactive-account and lockdown guards in the actual shared post',async()=>{
  const ref=await journal();
  try {
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
    await expect(actor('u1',()=>postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id))).rejects.toThrow('closed');
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
    await pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,debitAccount]);
    await expect(actor('u1',()=>postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id))).rejects.toThrow('deactivated');
    await pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,debitAccount]);
    await pool.query("UPDATE companies SET lockdown_enabled=true,lockdown_date='2026-09-09' WHERE id=$1",[fixture.companyA]);
    await expect(actor('u1',()=>postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id))).rejects.toThrow('lockdown');
  } finally {
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
    await pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,debitAccount]);
    await pool.query('UPDATE companies SET lockdown_enabled=false WHERE id=$1',[fixture.companyA]);
  }
});
it('outer rollback removes the actual posting and its immutable effect/events',async()=>{
  const ref=await journal();
  await expect(actor('u1',async()=>{await postJournalEntry(fixture.companyA,ref.entityId,fixture.u1.id);throw new Error('synthetic outer failure');})).rejects.toThrow('synthetic');
  expect((await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,ref.entityId])).rows[0].status).toBe('draft');
  expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,ref.entityId])).rows).toHaveLength(0);
  expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,ref.entityId])).rows).toHaveLength(0);
});

it('allows a real AP cancellation to reverse its linked legacy journal through a persisted contra relationship',async()=>{
  const original=await journal(),supplier=randomUUID(),invoice=randomUUID();
  await pool.query("UPDATE gl_journal_entries SET status='posted' WHERE company_id=$1 AND id=$2",[fixture.companyA,original.entityId]);
  await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic legacy GL supplier')",[supplier,fixture.companyA]);
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,currency,created_by,gl_journal_entry_id)
    VALUES($1,$2,$3,$4,'2026-09-09',115.10,'ZAR',$5,$6)`,[invoice,fixture.companyA,supplier,invoice,fixture.u1.id,original.entityId]);
  await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_amount)
    VALUES($1,'Synthetic source',1,115.10,115.10,0)`,[invoice]);
  const parent={entityType:'supplier_invoice',entityId:invoice,operation:'supplier_invoice.cancel' as const};
  const {registerGeneratedJournal}=await import('@/modules/accounting/services/controls/generatedJournalPermit');
  const result=await actor('u1',ctx=>executeControlledOperation(ctx,parent,null,async permit=>{
    const parentControl={permit,parent};
    await registerGeneratedJournal(ctx,parentControl,original.entityId,'journal.reverse');
    return reverseJournalEntry(fixture.companyA,original.entityId,fixture.u1.id,{parentControl});
  }));
  expect(result.status).toBe('posted');
  expect((await pool.query('SELECT reversal_of_id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,result.id])).rows[0].reversal_of_id).toBe(original.entityId);
});

it('refuses a related generated contra with a different monetary amount',async()=>{
  const original=await journal();await actor('u1',()=>postJournalEntry(fixture.companyA,original.entityId,fixture.u1.id));
  const parent={...original,operation:'journal.reverse' as const},childId=randomUUID();
  await expect(actor('u1',ctx=>executeControlledOperation(ctx,parent,null,async permit=>{
    await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by,reversal_of_id)
      VALUES(${childId}::uuid,${fixture.companyA}::uuid,${permit.accountingDate}::date,${period}::uuid,'manual','draft',${fixture.u1.id}::uuid,${original.entityId}::uuid)`;
    await ctx.sql`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
      VALUES(${childId}::uuid,${fixture.companyA}::uuid,${debitAccount}::uuid,100,0),
      (${childId}::uuid,${fixture.companyA}::uuid,${creditAccount}::uuid,0,100)`;
    const parentControl={permit,parent};await registerGeneratedJournal(ctx,parentControl,childId,'journal.post');
    return postJournalEntry(fixture.companyA,childId,fixture.u1.id,{parentControl});
  }))).rejects.toThrow('amount or currency');
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,childId])).rows).toHaveLength(0);
  expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='journal.reverse'",[fixture.companyA,original.entityId])).rows).toHaveLength(0);
});
