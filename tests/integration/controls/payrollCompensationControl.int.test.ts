import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assignComponentToEmployee,endEmployeeComponent} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const employee=randomUUID(),component=randomUUID(),assignment=randomUUID(),packageId=randomUUID(),batchId=randomUUID();
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'='u1'){const user=fixture[person],client=await pool.connect();
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
 await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'SYNTHETIC','Synthetic package')",[packageId,fixture.companyA]);
 await pool.query("INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,300,true)",[packageId,component]);
 await pool.query("INSERT INTO payroll_batches(id,company_id,batch_type,component_id,description,period_year,period_month,status,line_count,total_amount) VALUES($1,$2,'component_values',$3,'Synthetic batch',2026,12,'validated',1,400)",[batchId,fixture.companyA,component]);
 await pool.query("INSERT INTO payroll_batch_lines(batch_id,employee_id,value,effective_from) VALUES($1,$2,400,'2026-12-01')",[batchId,employee]);
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
  const {requestOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const requested=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
  const stored=await pool.query('SELECT binding FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,requested.id]);
  expect(stored.rows[0].binding.operation).toBe('payroll_compensation.change');
  expect(stored.rows[0].binding.amount).toMatch(/^250\.01(?:0+)?$/);
  expect(stored.rows[0].binding.policies).toEqual(expect.arrayContaining([expect.objectContaining({mandatory:true,approverRole:'admin'})]));
  await pool.query('UPDATE payroll_components SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,component]);
  await expect(actor(()=>loadPayrollCompensationIntent(requireControlTx(),prepared.intentId))).rejects.toThrow(/source changed/i);
 }finally{
  await pool.query('UPDATE payroll_components SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,component]);
  await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 }
});

it('refuses package application when current payroll write is denied',async()=>{
 const {applyPackageToEmployee}=await import('@/modules/accounting/services/payroll/payPackageService');
 await expect(actor(()=>assertEffectivePermission(requireControlTx(),'write:payroll'))).rejects.toThrow(/permissions/);
 await expect(actor(()=>applyPackageToEmployee(fixture.companyA,packageId,employee,'2026-11-01',fixture.u1.id))).rejects.toThrow(/permission|approval/i);
});
it('refuses validated batch posting when current payroll write is denied',async()=>{
 const {postBatch}=await import('@/modules/accounting/services/payroll/payrollBatchService');
 await expect(actor(()=>assertEffectivePermission(requireControlTx(),'write:payroll'))).rejects.toThrow(/permissions/);
 await expect(actor(()=>postBatch(fixture.companyA,batchId,fixture.u1.id))).rejects.toThrow(/permission|approval/i);
});

it('executes an independently approved compensation once and preserves protected evidence',async()=>{
 await pool.query("UPDATE company_user_permissions SET can_write=true WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 try{
  const {preparePayrollCompensation,executePayrollCompensation}=await import('@/modules/accounting/services/controls/payrollCompensationControl');
  const {requestOperationApproval,decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const prepared=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'123.45',effectiveFrom:'2027-01-01'}]}));
  await expect(actor(()=>executePayrollCompensation(requireControlTx(),prepared.intentId))).rejects.toThrow(/approval/i);
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
  await expect(actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'))).rejects.toThrow();
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  const result=await actor(()=>executePayrollCompensation(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
  expect(result.inserted).toBe(1);
  expect(await actor(()=>executePayrollCompensation(requireControlTx(),prepared.intentId))).toEqual(result);
  const effects=await pool.query("SELECT count(*)::int count FROM control_operation_effects WHERE company_id=$1 AND entity_type='payroll_compensation_intent' AND entity_id=$2",[fixture.companyA,prepared.intentId]);
  expect(effects.rows[0].count).toBe(1);
  const evidence=await pool.query("SELECT before_values,after_values,protected_evidence_id FROM control_change_events WHERE company_id=$1 AND entity_type='payroll_employee_component' AND entity_id=$2",[fixture.companyA,result.assignmentIds[0]]);
  expect(evidence.rows).toHaveLength(1);expect(evidence.rows[0].protected_evidence_id).toBeTruthy();expect(JSON.stringify(evidence.rows[0])).not.toContain('123.45');
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
  try{await expect(actor(()=>executePayrollCompensation(requireControlTx(),prepared.intentId))).rejects.toThrow();}
  finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);}

 }finally{await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('applies an approved package through the existing shared service and retains ended rows',async()=>{
 await pool.query("UPDATE company_user_permissions SET can_write=true WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 try{
  const {preparePayrollCompensation}=await import('@/modules/accounting/services/controls/payrollCompensationControl');
  const {requestOperationApproval,decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const {applyPackageToEmployee}=await import('@/modules/accounting/services/payroll/payPackageService');
  const prepared=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'package',sourceId:packageId,employeeId:employee},effectiveFrom:'2028-01-01'}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  const result=await actor(()=>applyPackageToEmployee(fixture.companyA,packageId,employee,'2028-01-01',fixture.u1.id,{intentId:prepared.intentId,approvalId:approval.id}));
  expect(result.inserted).toBe(1);expect(result.ended).toBeGreaterThan(0);
  expect((await pool.query('SELECT effective_to::text FROM payroll_employee_components WHERE id=$1',[assignment])).rows[0].effective_to).toBe('2027-12-31');
 }finally{await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('posts an approved validated batch through its existing shared service exactly once',async()=>{
 await pool.query("UPDATE company_user_permissions SET can_write=true WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 try{
  const {preparePayrollCompensation}=await import('@/modules/accounting/services/controls/payrollCompensationControl');
  const {requestOperationApproval,decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const {postBatch}=await import('@/modules/accounting/services/payroll/payrollBatchService');
  const prepared=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'batch',sourceId:batchId}}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  const options={intentId:prepared.intentId,approvalId:approval.id};
  expect(await actor(()=>postBatch(fixture.companyA,batchId,fixture.u1.id,options))).toEqual({inserted:1});
  expect(await actor(()=>postBatch(fixture.companyA,batchId,fixture.u1.id,options))).toEqual({inserted:1});
  expect((await pool.query('SELECT status FROM payroll_batches WHERE company_id=$1 AND id=$2',[fixture.companyA,batchId])).rows[0].status).toBe('posted');
 }finally{await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('refuses currently negative travel operands edited into an already validated batch before approval',async()=>{
 const travel=randomUUID(),travelComponent=randomUUID();
 await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Synthetic travel','3702','earning')",[travelComponent,fixture.companyA]);
 await pool.query("INSERT INTO payroll_batches(id,company_id,batch_type,description,period_year,period_month,status,line_count,total_amount) VALUES($1,$2,'reimbursive_travel','Synthetic travel',2026,12,'validated',1,50)",[travel,fixture.companyA]);
 await pool.query("INSERT INTO payroll_batch_lines(batch_id,employee_id,value,km,rate_per_km,taxable_portion,non_taxable_portion,effective_from) VALUES($1,$2,50,10,5,50,0,'2026-12-01')",[travel,employee]);
 await pool.query("UPDATE company_user_permissions SET can_write=true WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 try{
  const {addBatchLines}=await import('@/modules/accounting/services/payroll/payrollBatchService');
  await actor(()=>addBatchLines(fixture.companyA,travel,[{employeeId:employee,km:-10,ratePerKm:-5,taxablePortion:50,nonTaxablePortion:0,effectiveFrom:new Date('2026-12-01T00:00:00Z')}]));
  expect((await pool.query('SELECT km::text,rate_per_km::text FROM payroll_batch_lines WHERE batch_id=$1',[travel])).rows[0]).toEqual({km:'-10.00',rate_per_km:'-5.0000'});
  const {preparePayrollCompensation}=await import('@/modules/accounting/services/controls/payrollCompensationControl');
  const {requestOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  await expect(actor(async()=>{
   const prepared=await preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'batch',sourceId:travel}});
   return requestOperationApproval(requireControlTx(),prepared.operation);
  })).rejects.toThrow(/positive travel|travel.*positive/i);
 }finally{await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('serializes concurrent approved compensation retries into one assignment and effect',async()=>{
 await pool.query("UPDATE company_user_permissions SET can_write=true WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 try{
  const {preparePayrollCompensation,executePayrollCompensation}=await import('@/modules/accounting/services/controls/payrollCompensationControl');
  const {requestOperationApproval,decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const prepared=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'0.00',effectiveFrom:'2029-01-01'}]}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  const [first,second]=await Promise.all([actor(()=>executePayrollCompensation(requireControlTx(),prepared.intentId,{approvalId:approval.id})),actor(()=>executePayrollCompensation(requireControlTx(),prepared.intentId,{approvalId:approval.id}))]);
  expect(second).toEqual(first);expect(first.inserted).toBe(1);
  expect((await pool.query("SELECT count(*)::int count FROM control_operation_effects WHERE company_id=$1 AND entity_type='payroll_compensation_intent' AND entity_id=$2",[fixture.companyA,prepared.intentId])).rows[0].count).toBe(1);
 }finally{await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('rolls back compensation assignments, effects and child audit evidence with the outer transaction',async()=>{
 await pool.query("UPDATE company_user_permissions SET can_write=true WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);
 try{
  const {preparePayrollCompensation,executePayrollCompensation}=await import('@/modules/accounting/services/controls/payrollCompensationControl');
  const {requestOperationApproval,decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const prepared=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'175.00',effectiveFrom:'2029-02-01'}]}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  let childId='';await expect(actor(async()=>{const result=await executePayrollCompensation(requireControlTx(),prepared.intentId,{approvalId:approval.id});childId=result.assignmentIds[0]!;throw new Error('synthetic outer rollback');})).rejects.toThrow('synthetic outer rollback');
  expect((await pool.query('SELECT id FROM payroll_employee_components WHERE id=$1',[childId])).rows).toHaveLength(0);
  expect((await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_type='payroll_employee_component' AND entity_id=$2",[fixture.companyA,childId])).rows).toHaveLength(0);
  expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_type='payroll_compensation_intent' AND entity_id=$2",[fixture.companyA,prepared.intentId])).rows).toHaveLength(0);
  expect((await actor(()=>executePayrollCompensation(requireControlTx(),prepared.intentId,{approvalId:approval.id}))).inserted).toBe(1);
 }finally{await pool.query("UPDATE company_user_permissions SET can_write=false WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('never exposes a foreign component through an owned legacy assignment to a dual-company member',async()=>{
 const foreign=randomUUID(),legacy=randomUUID();
 await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(company_id,user_id) DO NOTHING",[fixture.companyB,fixture.u1.id]);
 await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'FOREIGN-PAYROLL-SECRET','3601','earning')",[foreign,fixture.companyB]);
 await pool.query("INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from,is_recurring) VALUES($1,$2,$3,10,'2026-09-01',true)",[legacy,employee,foreign]);
 try{
  const {listEmployeeComponentAssignments}=await import('@/modules/accounting/services/payroll/payrollEmployeeComponentService');
  const rows=await actor(()=>listEmployeeComponentAssignments(fixture.companyA,employee));
  expect(rows.some(row=>row.componentName==='FOREIGN-PAYROLL-SECRET')).toBe(false);
 }finally{await pool.query('DELETE FROM payroll_employee_components WHERE id=$1',[legacy]);}
});
it('never exposes a foreign employee through an owned legacy batch to a dual-company member',async()=>{
 const foreignEmployee=randomUUID(),legacyBatch=randomUUID();
 await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(company_id,user_id) DO NOTHING",[fixture.companyB,fixture.u1.id]);
 await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,'FOREIGN-NUMBER','FOREIGN-EMPLOYEE','SECRET','2020-01-01','active')",[foreignEmployee,fixture.companyB]);
 await pool.query("INSERT INTO payroll_batches(id,company_id,batch_type,component_id,description,period_year,period_month) VALUES($1,$2,'component_values',$3,'Legacy synthetic cross-link',2026,12)",[legacyBatch,fixture.companyA,component]);
 await pool.query("INSERT INTO payroll_batch_lines(batch_id,employee_id,value,effective_from) VALUES($1,$2,10,'2026-12-01')",[legacyBatch,foreignEmployee]);
 const {getBatch}=await import('@/modules/accounting/services/payroll/payrollBatchService');
 const result=await actor(()=>getBatch(fixture.companyA,legacyBatch));
 expect(result.lines.some(line=>line.employeeName?.includes('FOREIGN-EMPLOYEE')||line.employeeNumber==='FOREIGN-NUMBER')).toBe(false);
});
