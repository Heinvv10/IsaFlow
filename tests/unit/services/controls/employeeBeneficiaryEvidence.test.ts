import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {storeEmployeeBeneficiaryEvidence,readEmployeeBeneficiaryEvidence,validateEmployeeBeneficiaryEvidence} from '@/modules/accounting/services/controls/employeeBeneficiaryEvidence';
const mocks=vi.hoisted(()=>({permission:vi.fn(),event:vi.fn(),query:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:mocks.event}));
const company='11111111-1111-4111-8111-111111111111',employee='22222222-2222-4222-8222-222222222222',person='33333333-3333-4333-8333-333333333333';
const bytes=Buffer.from('%PDF-1.4\nSynthetic employee bank confirmation');
let stored:Record<string,unknown>|null;
async function run<T>(fn:(ctx:ReturnType<typeof requireControlTx>)=>Promise<T>,pat=false){
 return withControlRequest({client:{query:mocks.query} as unknown as PoolClient,userId:person,companyId:company,claims:{}},
  {personId:person,companyId:company,authMethod:pat?'pat':'cookie',connectionId:pat?person:null,grantId:pat?person:null,grantedScopes:pat?['write:payroll','write:beneficiaries']:null},()=>fn(requireControlTx()));
}
beforeEach(()=>{
 vi.clearAllMocks();stored=null;process.env.ENCRYPTION_KEY=['synthetic','employee','evidence','key','32'].join('-');process.env.CONTROL_FINGERPRINT_KEY='synthetic-employee-fingerprint-key-32';
 mocks.query.mockImplementation(async(text:string,args:unknown[])=>{
  if(text.includes('INSERT INTO control_employee_beneficiary_evidence')){
   const [c,id,e,envelope,hash,length,mime,creator]=args;stored={company_id:c,id,employee_id:e,document_envelope:JSON.parse(String(envelope)),content_sha256:hash,byte_length:length,mime_type:mime,created_by_person_id:creator};
   return{rows:[{id}]};
  }
  if(text.includes('FROM control_employee_beneficiary_evidence'))return{rows:stored?[stored]:[]};
  if(text.includes('FROM payroll_employees'))return{rows:[{id:employee}]};
  return{rows:[]};
 });
});
it('stores real bytes encrypted with employee binding and returns only a protected evidence reference',async()=>{
 const ref=await run(ctx=>storeEmployeeBeneficiaryEvidence(ctx,{employeeId:employee,bytes,mimeType:'application/pdf'}));
 expect(ref).toMatchObject({store:'protected',entityType:'employee',entityId:employee,version:null,hash:createHash('sha256').update(bytes).digest('hex')});
 expect(JSON.stringify(stored)).not.toContain(bytes.toString());expect(JSON.stringify(stored)).not.toContain(bytes.toString('base64'));
 const read=await run(ctx=>readEmployeeBeneficiaryEvidence(ctx,ref.evidenceId));expect(read.bytes).toEqual(bytes);
 expect(mocks.permission.mock.calls.map(c=>c[1])).toEqual(expect.arrayContaining(['write:payroll','write:beneficiaries','read:payroll','read:payroll-sensitive']));
});
it('refuses bearer reveal even when the bearer has maintenance rights',async()=>{
 const ref=await run(ctx=>storeEmployeeBeneficiaryEvidence(ctx,{employeeId:employee,bytes,mimeType:'application/pdf'}));
 await expect(run(ctx=>readEmployeeBeneficiaryEvidence(ctx,ref.evidenceId),true)).rejects.toThrow('HUMAN_REQUIRED');
});
it('rejects altered document bytes/hash or a different employee association',async()=>{
 const ref=await run(ctx=>storeEmployeeBeneficiaryEvidence(ctx,{employeeId:employee,bytes,mimeType:'application/pdf'}));
 await expect(run(ctx=>validateEmployeeBeneficiaryEvidence(ctx,{entityType:'employee',entityId:person},[ref]))).rejects.toThrow();
 stored!.content_sha256='0'.repeat(64);
 await expect(run(ctx=>validateEmployeeBeneficiaryEvidence(ctx,{entityType:'employee',entityId:employee},[ref]))).rejects.toThrow('EVIDENCE_UNAVAILABLE_OR_CHANGED');
});
it('refuses empty or oversized bytes and unsupported MIME before persisting evidence',async()=>{
 for(const input of [{employeeId:employee,bytes:Buffer.alloc(0),mimeType:'application/pdf'},
  {employeeId:employee,bytes:Buffer.alloc(10485761),mimeType:'application/pdf'},
  {employeeId:employee,bytes,mimeType:'text/html'}])await expect(run(ctx=>storeEmployeeBeneficiaryEvidence(ctx,input))).rejects.toThrow();
 expect(stored).toBeNull();
});
it('rejects a declared document MIME when byte signatures disagree',async()=>{
 await expect(run(ctx=>storeEmployeeBeneficiaryEvidence(ctx,{employeeId:employee,bytes:Buffer.from('<html>not a pdf</html>'),mimeType:'application/pdf'}))).rejects.toThrow('INVALID_EVIDENCE');
 expect(stored).toBeNull();
});
