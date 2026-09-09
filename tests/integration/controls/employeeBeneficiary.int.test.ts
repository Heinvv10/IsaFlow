import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {NextApiRequest,NextApiResponse} from 'next';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {storeEmployeeBeneficiaryEvidence,readEmployeeBeneficiaryEvidence} from '@/modules/accounting/services/controls/employeeBeneficiaryEvidence';
import {verifyBeneficiaryChange,rejectBeneficiaryChange} from '@/modules/accounting/services/controls/beneficiaryService';
import {proposePayrollBankDetails,getVerifiedPayrollBankDetails} from '@/modules/accounting/services/payroll/payrollBankDetailService';
import {createPayrollEmployee,updatePayrollEmployee} from '@/modules/accounting/services/payroll/payrollEmployeeService';
import {openProtectedChange} from '@/modules/accounting/services/controls/changeProtection';
import {lockPayrollSources} from '@/modules/accounting/services/controls/payrollSourceMaterial';
import {payrollCalculationHashes,assertPayrollCalculationReceipt} from '@/modules/accounting/services/controls/payrollCalculationReceipt';
import employeePost from '../../../pages/api/payroll/employees/index';
// Real business handler under synthetic authenticated transaction; transport admission wrappers are mocked only here.
vi.mock('@/lib/auth',()=>({withAuth:(h:unknown)=>h}));
vi.mock('@/lib/auth/withCsrf',()=>({withCsrf:(h:unknown)=>h}));
vi.mock('@/lib/auth/withWriteAccess',()=>({withWriteAccess:(h:unknown)=>h}));
vi.mock('@/lib/api-error-handler',()=>({withErrorHandler:(h:unknown)=>h}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
process.env.ENCRYPTION_KEY=['synthetic','employee','beneficiary','key','32'].join('-');process.env.CONTROL_FINGERPRINT_KEY='synthetic-employee-beneficiary-hmac-32';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:10000});
let fixture:ForensicFixture;
const scopes=['write:payroll','write:beneficiaries','read:payroll','read:payroll-sensitive'];
const bankA={bankName:'Synthetic bank',accountNumber:'00123456789',branchCode:'001234',accountType:'cheque'};
const bankB={...bankA,accountNumber:'00987654321'};
const bytes=Buffer.from('%PDF-1.4\nSynthetic independently reviewed bank confirmation\n%%EOF');
const base=()=>({employeeNumber:randomUUID().slice(0,16),firstName:'Synthetic',lastName:'Employee',employmentType:'permanent' as const,startDate:new Date('2026-01-01'),uifExcluded:false,medicalAidMainMember:false,medicalAidDependantsCount:0});
beforeAll(async()=>{fixture=await provisionForensicFixture(config);await restore();});
afterEach(restore);
afterAll(async()=>{await pool.end();});
async function restore(){if(!fixture)return;await pool.query('UPDATE personal_access_tokens SET scopes=$2::text[] WHERE company_id=$1',[fixture.companyA,scopes]);await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1',[fixture.companyA]);}
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',tokenIndex?:number):Promise<T>{
 const client=await pool.connect(),user=fixture[person],companyId=user.companyId,token=tokenIndex===undefined?null:fixture.u1.tokens[tokenIndex]!;
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId,claims},{personId:user.id,companyId,authMethod:token?'pat':'cookie',
   connectionId:token?.id,grantId:token?.id,grantedScopes:token?scopes:null},()=>fn(requireControlTx()));
  const outcome=await client.query('COMMIT');if(outcome.command!=='COMMIT')throw new Error('Transaction did not commit');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function employee(bank?:typeof bankA){
 const created=await actor(()=>createPayrollEmployee(fixture.companyA,base()));
 if(bank)await pool.query('INSERT INTO payroll_bank_details(employee_id,bank_name,account_number,account_type,branch_code) VALUES($1,$2,$3,$4,$5)',[created.id,bank.bankName,bank.accountNumber,bank.accountType,bank.branchCode]);
 return created.id;
}
async function evidence(employeeId:string){return actor(ctx=>storeEmployeeBeneficiaryEvidence(ctx,{employeeId,bytes,mimeType:'application/pdf'}));}
async function banks(id:string){return(await pool.query('SELECT b.* FROM payroll_bank_details b JOIN payroll_employees e ON e.id=b.employee_id WHERE e.company_id=$1 AND e.id=$2 ORDER BY b.created_at,b.id',[fixture.companyA,id])).rows;}
async function enrolled(){const id=await employee(bankA),proof=await evidence(id);const p=await actor(()=>proposePayrollBankDetails(fixture.companyA,id,bankA,[proof]));await actor(ctx=>verifyBeneficiaryChange(ctx,p.proposalId,[proof]),'u2');return{id,proof};}
it('actual employee POST creates bankless employee plus encrypted pending review and protected exact event',async()=>{
 const data={...base(),bankDetails:bankB,taxNumber:'1234567890'};const state:{code:number;body:unknown}={code:0,body:null};
 const res={status:(code:number)=>{state.code=code;return res;},json:(body:unknown)=>{state.body=body;return res;},setHeader:vi.fn()};
 await actor(async()=>{await employeePost({method:'POST',companyId:fixture.companyA,body:data} as unknown as NextApiRequest,res as unknown as NextApiResponse);});
 expect(state.code).toBe(201);expect(JSON.stringify(state.body)).toContain('pending');expect(JSON.stringify(state.body)).not.toContain(bankB.accountNumber);
 const row=(await pool.query('SELECT id FROM payroll_employees WHERE company_id=$1 AND employee_number=$2',[fixture.companyA,data.employeeNumber])).rows[0];
 expect(await banks(row.id)).toHaveLength(0);
 const proposals=(await pool.query('SELECT details_envelope,status FROM control_beneficiary_proposals WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,row.id])).rows;
 expect(proposals).toHaveLength(1);expect(JSON.stringify(proposals)).not.toContain(bankB.accountNumber);
 const events=await pool.query('SELECT after_values FROM control_change_events WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,row.id]);expect(JSON.stringify(events.rows)).not.toContain(data.taxNumber);
 const protectedRow=(await pool.query("SELECT key_id,envelope_version,ciphertext FROM control_protected_evidence WHERE company_id=$1 AND entity_type='employee' AND entity_id=$2",[fixture.companyA,row.id])).rows[0];
 expect(openProtectedChange({version:protectedRow.envelope_version,keyId:protectedRow.key_id,ciphertext:protectedRow.ciphertext}).after?.tax_number).toBe(data.taxNumber);
});
it('independent cookie verification activates real employee evidence; same person and second token cannot verify',async()=>{
 const id=await employee(bankA),proof=await evidence(id),p=await actor(()=>proposePayrollBankDetails(fixture.companyA,id,bankB,[proof]));
 expect((await banks(id)).find(b=>b.is_active).account_number).toBe(bankA.accountNumber);
 await expect(actor(ctx=>verifyBeneficiaryChange(ctx,p.proposalId,[proof]))).rejects.toThrow('INDEPENDENT_PERSON_REQUIRED');
 await expect(actor(ctx=>verifyBeneficiaryChange(ctx,p.proposalId,[proof]),'u1',1)).rejects.toThrow('HUMAN_REQUIRED');
 await actor(ctx=>verifyBeneficiaryChange(ctx,p.proposalId,[proof]),'u2');
 expect((await banks(id)).filter(b=>b.is_active)).toHaveLength(1);expect((await banks(id)).find(b=>b.is_active).account_number).toBe(bankB.accountNumber);
 expect((await actor(ctx=>getVerifiedPayrollBankDetails(ctx,id))).details).toEqual(bankB);
});
it('restricted evidence reveal requires a current human payroll-sensitive grant and rejects cross-tenant IDs',async()=>{
 const id=await employee(),proof=await evidence(id);
 expect((await actor(ctx=>readEmployeeBeneficiaryEvidence(ctx,proof.evidenceId),'u2')).bytes).toEqual(bytes);
 await expect(actor(ctx=>readEmployeeBeneficiaryEvidence(ctx,proof.evidenceId),'u1',0)).rejects.toThrow('HUMAN_REQUIRED');
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll_sensitive',false)",[fixture.companyA,fixture.u2.id]);
 await expect(actor(ctx=>readEmployeeBeneficiaryEvidence(ctx,proof.evidenceId),'u2')).rejects.toThrow('permissions');
 await expect(actor(ctx=>readEmployeeBeneficiaryEvidence(ctx,proof.evidenceId),'u3')).rejects.toThrow('EVIDENCE_UNAVAILABLE_OR_CHANGED');
 const rows=await pool.query('SELECT document_envelope FROM control_employee_beneficiary_evidence WHERE company_id=$1 AND id=$2',[fixture.companyA,proof.evidenceId]);
 expect(JSON.stringify(rows.rows)).not.toContain(bytes.toString('base64'));
});
it('pending hold blocks previously verified banking, rejection preserves A, and a second proposal activates B',async()=>{
 const{id,proof}=await enrolled(),first=await actor(ctx=>getVerifiedPayrollBankDetails(ctx,id));
 const p=await actor(()=>proposePayrollBankDetails(fixture.companyA,id,bankB,[]));
 await expect(actor(ctx=>getVerifiedPayrollBankDetails(ctx,id))).rejects.toThrow('PENDING_HOLD');
 await actor(ctx=>rejectBeneficiaryChange(ctx,p.proposalId,'Synthetic independent rejection'),'u2');
 expect((await actor(ctx=>getVerifiedPayrollBankDetails(ctx,id))).details).toEqual(bankA);
 const next=await actor(()=>proposePayrollBankDetails(fixture.companyA,id,bankB,[proof]));await actor(ctx=>verifyBeneficiaryChange(ctx,next.proposalId,[proof]),'u2');
 const second=await actor(ctx=>getVerifiedPayrollBankDetails(ctx,id));expect(second.version).toBe(first.version+1);expect(second.fingerprint).not.toBe(first.fingerprint);
});
it('wrong employee or changed document cannot activate a proposal',async()=>{
 const a=await employee(bankA),b=await employee(bankA),proof=await evidence(a),p=await actor(()=>proposePayrollBankDetails(fixture.companyA,b,bankB,[]));
 await expect(actor(ctx=>verifyBeneficiaryChange(ctx,p.proposalId,[proof]),'u2')).rejects.toThrow('INVALID_EVIDENCE');
 const own=await evidence(b);await pool.query("UPDATE control_employee_beneficiary_evidence SET content_sha256=repeat('0',64) WHERE company_id=$1 AND id=$2",[fixture.companyA,own.evidenceId]);
 await expect(actor(ctx=>verifyBeneficiaryChange(ctx,p.proposalId,[own]),'u2')).rejects.toThrow('EVIDENCE_UNAVAILABLE_OR_CHANGED');
 expect((await banks(b)).find(r=>r.is_active).account_number).toBe(bankA.accountNumber);
});
it('revoked current requester payroll scope prevents independent activation',async()=>{
 const id=await employee(bankA),proof=await evidence(id),p=await actor(()=>proposePayrollBankDetails(fixture.companyA,id,bankB,[proof]),'u1',0);
 await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['write:beneficiaries'] WHERE company_id=$1 AND id=$2",[fixture.companyA,fixture.u1.tokens[0]!.id]);
 await expect(actor(ctx=>verifyBeneficiaryChange(ctx,p.proposalId,[proof]),'u2')).rejects.toThrow('REQUESTER_REVOKED');
 expect((await banks(id)).find(r=>r.is_active).account_number).toBe(bankA.accountNumber);
});
it('ordinary and unchanged-bank payroll-only edits work, while a changed bank rejects the whole employee save',async()=>{
 const id=await employee(bankA);await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['write:payroll'] WHERE company_id=$1 AND id=$2",[fixture.companyA,fixture.u1.tokens[0]!.id]);
 await actor(()=>updatePayrollEmployee(id,fixture.companyA,{firstName:'Allowed',bankDetails:bankA}),'u1',0);
 await expect(actor(()=>updatePayrollEmployee(id,fixture.companyA,{firstName:'Denied',bankDetails:bankB}),'u1',0)).rejects.toThrow('permissions');
 expect((await pool.query('SELECT first_name FROM payroll_employees WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].first_name).toBe('Allowed');
 expect((await banks(id)).find(r=>r.is_active).account_number).toBe(bankA.accountNumber);
});
it('employee edits make the actual persisted payroll source snapshot stale',async()=>{
 const id=await employee(),run=randomUUID();await pool.query('INSERT INTO payroll_run_headers(id,company_id,period_month,period_year) VALUES($1,$2,9,2026)',[run,fixture.companyA]);
 const receipt=await actor(async ctx=>payrollCalculationHashes(await lockPayrollSources(ctx,run)));
 await actor(()=>updatePayrollEmployee(id,fixture.companyA,{medicalAidDependantsCount:2}));
 await expect(actor(async ctx=>assertPayrollCalculationReceipt(await lockPayrollSources(ctx,run),receipt))).rejects.toThrow('stale');
});
it('ambiguous/future active banking and unverified employees fail closed',async()=>{
 const id=await employee(bankA);await pool.query("UPDATE payroll_bank_details SET effective_from=CURRENT_DATE+2 WHERE employee_id=$1",[id]);
 await expect(actor(ctx=>getVerifiedPayrollBankDetails(ctx,id))).rejects.toThrow('FUTURE_EFFECTIVE_BANKING_UNSUPPORTED');
 await pool.query('INSERT INTO payroll_bank_details(employee_id,bank_name,account_number,account_type,branch_code) VALUES($1,$2,$3,$4,$5)',[id,bankB.bankName,bankB.accountNumber,bankB.accountType,bankB.branchCode]);
 await expect(actor(ctx=>getVerifiedPayrollBankDetails(ctx,id))).rejects.toThrow('AMBIGUOUS_BANKING');
 const empty=await employee();
 await expect(actor(ctx=>getVerifiedPayrollBankDetails(ctx,empty))).rejects.toThrow('LEGACY_UNVERIFIED');
});
it('app role cannot mutate/delete/truncate employee evidence or spoof its employee tenant',async()=>{
 const id=await employee(),proof=await evidence(id);
 for(const command of ['UPDATE control_employee_beneficiary_evidence SET mime_type=mime_type','DELETE FROM control_employee_beneficiary_evidence','TRUNCATE control_employee_beneficiary_evidence']){
  await expect(actor(async ctx=>{if(command.startsWith('UPDATE'))await ctx.sql`UPDATE control_employee_beneficiary_evidence SET mime_type=mime_type WHERE company_id=${fixture.companyA}::uuid`;
   else if(command.startsWith('DELETE'))await ctx.sql`DELETE FROM control_employee_beneficiary_evidence WHERE company_id=${fixture.companyA}::uuid`;
   else await ctx.sql`TRUNCATE control_employee_beneficiary_evidence`;})).rejects.toThrow('permission denied');
 }
 await expect(actor(ctx=>storeEmployeeBeneficiaryEvidence(ctx,{employeeId:id,bytes,mimeType:'application/pdf'}),'u3')).rejects.toThrow('NOT_FOUND');
 expect((await actor(ctx=>readEmployeeBeneficiaryEvidence(ctx,proof.evidenceId))).bytes).toEqual(bytes);
});
