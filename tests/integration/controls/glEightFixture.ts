import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {vi} from 'vitest';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {createJournalEntry,postJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
export async function glEightFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:10000});
 try{
 const f=await provisionForensicFixture(config);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'GL eight September',9,2026,'2026-09-01','2026-09-30','open')",[f.companyA]);
 await pool.query("INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,'GL eight independent posting','journal_entry','amount','any',0,'admin')",[f.companyA]);
 async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,queries:string[]=[],person:'u1'|'u2'|'u3'='u1'){
  const client=await pool.connect(),u=f[person],spy=vi.spyOn(client,'query');
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:u.id,company_id:u.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),u.companyId]);
   const value=await withControlRequest({client,userId:u.id,companyId:u.companyId,claims},{personId:u.id,companyId:u.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
   if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic GL transaction failed to commit');return value;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{
   for(const call of spy.mock.calls){const query=call[0] as unknown;queries.push(typeof query==='string'?query:String((query as {text?:string})?.text??''));}
   spy.mockRestore();client.release();
  }
 }
 async function account(options:{active?:boolean;system?:boolean;company?:string}={}){const id=randomUUID();
  await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,12),'Loan Account - Blitz Fibre','asset','debit',3,$3,$4)",[id,options.company??f.companyA,options.active??true,options.system??false]);return id;
 }
 async function post(accountId:string,signed:number){const other=await account();
  const lines=[{glAccountId:accountId,debit:Math.max(signed,0),credit:Math.max(-signed,0)},
   {glAccountId:other,debit:Math.max(-signed,0),credit:Math.max(signed,0)}];
  const draft=await actor(()=>createJournalEntry(f.companyA,{entryDate:'2026-09-09',description:'Real GL eight money',source:'manual',lines},f.u1.id));
  const approval=await actor(ctx=>requestOperationApproval(ctx,{operation:'journal.post',entityType:'journal_entry',entityId:draft.id}));
  await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),[],'u2');
  await actor(()=>postJournalEntry(f.companyA,draft.id,f.u1.id,{approvalId:approval.id}));return draft.id;
 }
 async function state(){const result:Record<string,unknown>={};
  for(const table of ['gl_accounts','gl_journal_entries','gl_journal_lines','control_change_events','control_entity_versions','control_protected_evidence'])
   result[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE company_id=$1 ORDER BY to_jsonb(t)::text`,[f.companyA])).rows;
  return result;
 }
 return{f,pool,actor,account,post,state,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}
