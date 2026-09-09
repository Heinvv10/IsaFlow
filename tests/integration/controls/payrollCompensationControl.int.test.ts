import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assignComponentToEmployee,endEmployeeComponent} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const employee=randomUUID(),component=randomUUID(),assignment=randomUUID();
async function actor<T>(fn:()=>Promise<T>){const user=fixture.u1,client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  const result=await withControlRequest({client,userId:user.id,companyId:fixture.companyA,claims},{personId:user.id,companyId:fixture.companyA,authMethod:'cookie'},fn);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
beforeAll(async()=>{fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,'COMP-RED','Synthetic','Compensation','2020-01-01','active')",[employee,fixture.companyA]);
 await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Synthetic salary','3601','earning')",[component,fixture.companyA]);
 await pool.query("INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from,is_recurring) VALUES($1,$2,$3,100,'2026-09-01',true)",[assignment,employee,component]);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'payroll',true,false)",[fixture.companyA,fixture.u1.id]);
});
afterAll(()=>pool.end());
it('refuses direct compensation assignment when the current payroll write grant is denied',async()=>{
 await expect(actor(()=>assertEffectivePermission(requireControlTx(),'write:payroll'))).rejects.toThrow(/permissions/);
 await expect(actor(()=>assignComponentToEmployee(fixture.companyA,employee,component,200,new Date('2026-10-01T00:00:00Z')))).rejects.toThrow(/permission|approval/i);
});
it('refuses direct compensation closure when the current payroll write grant is denied',async()=>{
 await expect(actor(()=>assertEffectivePermission(requireControlTx(),'write:payroll'))).rejects.toThrow(/permissions/);
 await expect(actor(()=>endEmployeeComponent(fixture.companyA,assignment,new Date('2026-09-30T00:00:00Z')))).rejects.toThrow(/permission|approval/i);
});
it('prepares immutable compensation without mutating assignments and binds subsequent source changes',async()=>{
 await pool.query("UPDATE company_user_permissions SET can_write=true WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 try{
  const {preparePayrollCompensation}=await import('@/modules/accounting/services/controls/payrollCompensationControl');
  const {loadPayrollCompensationIntent}=await import('@/modules/accounting/services/controls/payrollCompensationMaterial');
  const before=await pool.query('SELECT count(*)::int count FROM payroll_employee_components WHERE employee_id=$1',[employee]);
  const prepared=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'250.01',effectiveFrom:'2026-11-01'}]}));
  expect((await pool.query('SELECT count(*)::int count FROM payroll_employee_components WHERE employee_id=$1',[employee])).rows).toEqual(before.rows);
  expect((await actor(()=>loadPayrollCompensationIntent(requireControlTx(),prepared.intentId))).intent.amount).toBe('250.01000000');
  await pool.query('UPDATE payroll_components SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,component]);
  await expect(actor(()=>loadPayrollCompensationIntent(requireControlTx(),prepared.intentId))).rejects.toThrow(/source changed/i);
 }finally{
  await pool.query('UPDATE payroll_components SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,component]);
  await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 }
});
