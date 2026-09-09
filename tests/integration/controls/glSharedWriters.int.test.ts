import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { materializeGlOperation } from '@/modules/accounting/services/controls/glOperationMaterializer';
import { operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:7000});
let fixture:ForensicFixture;
const debitAccount=randomUUID(),creditAccount=randomUUID(),period=randomUUID();
async function actor<T>(person:'u1'|'u3',fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
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
  expect(hash(await actor('u1',ctx=>materializeGlOperation(ctx,ref)))).not.toBe(changed);
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
