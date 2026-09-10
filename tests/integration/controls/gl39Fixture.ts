/** Real issued-context GL regression fixture. Unposted sources and explicitly invalid status fixtures; no fabricated control receipts. */
import {Pool} from 'pg';
import {PAT_SCOPES} from '@/lib/auth/patScopes';
import {randomBytes,randomUUID} from 'node:crypto';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {postJournalEntry,reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryPostingService';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {fmtDate} from '@/lib/fmtDate';
export async function gl39Fixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.ENCRYPTION_KEY??=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY??=randomBytes(32).toString('hex');
 const f=await provisionForensicFixture(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:7000});
 const periods={original:randomUUID(),target:randomUUID(),today:randomUUID()},today=fmtDate(new Date());
 try{
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[f.companyA]);
  for(const [index,[id,start,end,name]] of [[periods.original,'2026-03-01','2026-03-31','Original'],[periods.target,'2026-04-01','2026-04-30','Target'],[periods.today,today,today,'Today']].entries())await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,$3,$6,2026,$4,$5,'open')",[id,f.companyA,name,start,end,index+1]);
 }catch(error){await pool.end();throw error;}
 async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,who:'u1'|'u2'|'u3'='u1',pat=false,rejectContraPost=false):Promise<T>{
  const user=f[who],client=await pool.connect();let begun=false;
  try{
   await client.query('BEGIN');begun=true;
   if(rejectContraPost){
    await client.query("CREATE FUNCTION pg_temp.gl39_reject_contra() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reversal_of_id IS NOT NULL AND NEW.status='posted' THEN RAISE EXCEPTION 'Synthetic child posting failure'; END IF; RETURN NEW; END $$");
    await client.query('CREATE TRIGGER gl39_reject_contra BEFORE UPDATE OF status ON gl_journal_entries FOR EACH ROW EXECUTE FUNCTION pg_temp.gl39_reject_contra()');
   }
   await client.query('SET LOCAL ROLE app_user');
   const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const token=user.tokens[0]!;
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:pat?'pat':'cookie',...(pat?{connectionId:token.id,grantId:token.id,grantedScopes:PAT_SCOPES}:{})},()=>fn(requireControlTx()));
   // Failure-injection DDL must never survive, including an unexpectedly successful callback.
   await client.query(rejectContraPost?'ROLLBACK':'COMMIT');begun=false;return result;
  }catch(error){if(begun)await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function journal(){
  const id=randomUUID(),accounts=[randomUUID(),randomUUID()];
  for(const [i,account] of accounts.entries())await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$2,$3,$4,$5,$6,3,true)",[account,f.companyA,account.slice(0,12),`GL39 account ${i}`,i?'liability':'asset',i?'credit':'debit']);
  await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by) VALUES($1,$2,'2026-03-15',$3,'manual','draft',$4)",[id,f.companyA,periods.original,f.u1.id]);
  await pool.query('INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit) VALUES($1,$2,$3,1000.23,0),($1,$2,$4,0,1000.23)',[id,f.companyA,...accounts]);
  return{id,accounts};
 }
 const post=(id:string)=>actor(()=>postJournalEntry(f.companyA,id,f.u1.id));
 const reverse=(id:string,date?:string)=>actor(()=>reverseJournalEntry(f.companyA,id,f.u1.id,{reversalDate:date}));
 const state=async(id:string)=>(await pool.query('SELECT id,status,reversed_at,fiscal_period_id,entry_date::text,posting_agent,actor_type,actor_token_jti FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0];
 async function approvedReverse(id:string,date:string,pat=false){
  const rule=randomUUID();await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,approver_role) VALUES($1,$2,'GL39 approval','journal_entry','amount','any','admin')",[rule,f.companyA]);
  try{
   const ref={entityType:'journal_entry',entityId:id,operation:'journal.reverse' as const,reversalDate:date};
   const approval=await actor(ctx=>requestOperationApproval(ctx,ref),'u1',pat);
   await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
   return await actor(()=>reverseJournalEntry(f.companyA,id,f.u1.id,{reversalDate:date,approvalId:approval.id,...(pat?{postingAgent:'mcp:reverse_journal:v1',actorType:'agent' as const,actorTokenJti:f.u1.tokens[0]!.id}:{})}),'u1',pat);
  }finally{await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[f.companyA,rule]);}
 }
 async function period(status:string,id=periods.original){await pool.query('UPDATE fiscal_periods SET status=$1 WHERE company_id=$2 AND id=$3',[status,f.companyA,id]);}
 return{f,pool,periods,today,actor,journal,post,reverse,state,approvedReverse,period,close:()=>pool.end()};
}
