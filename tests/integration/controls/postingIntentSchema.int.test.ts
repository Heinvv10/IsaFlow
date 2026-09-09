import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(async()=>{await pool.end();});
it.each(['control_bank_transfer_intents','control_asset_depreciation_intents',
 'control_credit_note_applications','control_recurring_invoice_runs',
 'control_bank_allocation_intents','control_bank_allocation_reversal_intents'])('enforces immutable tenant-scoped storage for %s',async table=>{
 const rows=await pool.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,
  has_table_privilege('app_user',c.oid,'SELECT') AS readable,
  has_table_privilege('app_user',c.oid,'INSERT') AS insertable,
  has_table_privilege('app_user',c.oid,'UPDATE,DELETE,TRUNCATE') AS mutable
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`,[table]);
 expect(rows.rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true,readable:true,insertable:true,mutable:false}]);
 const policies=await pool.query('SELECT cmd,qual,with_check FROM pg_policies WHERE schemaname=$1 AND tablename=$2 ORDER BY cmd',['public',table]);
 expect(policies.rows.map(row=>row.cmd)).toEqual(['INSERT','SELECT']);
 for(const policy of policies.rows)expect(policy.qual??policy.with_check).toContain('current_company_id');
 expect(policies.rows[0].with_check).toContain('requester_person_id');
 const fks=await pool.query(`SELECT conkey FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f'`,[table]);
 expect(fks.rows.some(row=>row.conkey.length>=2)).toBe(true);
});
it('stores explicit nullable legacy AR currency without fabricated backfills',async()=>{
 const rows=await pool.query(`SELECT table_name,is_nullable,column_default FROM information_schema.columns
  WHERE table_schema='public' AND table_name=ANY($1) AND column_name='currency_code' ORDER BY table_name`,
 [['credit_notes','customer_payments','recurring_invoices']]);
 expect(rows.rows).toEqual(['credit_notes','customer_payments','recurring_invoices'].map(table_name=>({table_name,is_nullable:'YES',column_default:null})));
});
it('enforces one immutable depreciation intent per owned asset and calendar month',async()=>{
 const result=await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE conrelid='control_asset_depreciation_intents'::regclass AND contype='u'`);
 expect(result.rows).toContainEqual({definition:'UNIQUE (company_id, asset_id, period_key)'});
});
